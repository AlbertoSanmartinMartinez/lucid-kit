// SPDX-License-Identifier: Apache-2.0
// A Merkle tree over a list that only grows, as Certificate Transparency defines it: RFC 6962,
// section 2.1, for the tree and its proofs, and RFC 9162, sections 2.1.3.2 and 2.1.4.2, for how a
// proof is checked.
//
// The root of the tree says what the whole list is: change, drop or reorder one entry and the
// root is another. Whoever holds a root can be shown, with a handful of hashes, that an entry is
// in the list (a proof of inclusion) and that a later, longer list starts with the same entries (a
// proof of consistency). And whoever reads every entry can work the root out alone, keeping no
// more than a hash per power of two the list is made of (`Frontier`).
//
// A leaf is hashed with a 0x00 in front and an inner node with a 0x01, so that one can never be
// passed off as the other.

import { createHash } from 'node:crypto';

const sha256 = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

/** The root of a list with nothing in it. */
export const EMPTY_ROOT = sha256();

/** The hash of an entry of the list: `data` is its bytes. */
export const leafHash = (data) => sha256(LEAF, data);

/** The hash of the node whose children are `left` and `right`. */
export const nodeHash = (left, right) => sha256(NODE, left, right);

/** The largest power of two smaller than `n`, for `n` greater than one. */
const split = (n) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isHash = (value) => Buffer.isBuffer(value) && value.length === 32;
const odd = (n) => n % 2 === 1;
const half = (n) => Math.floor(n / 2);

/**
 * The tree of a list that is all here: every leaf hash, and the hash of every complete subtree,
 * so that a root or a proof for any earlier size costs a number of hashes that grows with the
 * logarithm of the list, not with the list.
 */
export class MerkleTree {
  #levels = [[]]; // #levels[h][i]: the hash of the complete subtree over leaves [i * 2^h, (i + 1) * 2^h)

  get size() {
    return this.#levels[0].length;
  }

  /** Adds an entry, given its leaf hash. Returns its index. */
  append(leaf) {
    if (!isHash(leaf)) throw new TypeError('a leaf hash is 32 bytes');
    this.#levels[0].push(leaf);
    for (let h = 0; this.#levels[h].length % 2 === 0; h++) {
      const level = this.#levels[h];
      if (!this.#levels[h + 1]) this.#levels.push([]);
      this.#levels[h + 1].push(nodeHash(level.at(-2), level.at(-1)));
    }
    return this.size - 1;
  }

  /** The hash of the leaves [start, end): MTH of that part of the list. */
  #range(start, end) {
    const n = end - start;
    if (n === 0) return EMPTY_ROOT;
    const height = Math.log2(n);
    if (Number.isInteger(height) && start % n === 0) return this.#levels[height][start / n]; // a complete subtree, kept
    const k = split(n);
    return nodeHash(this.#range(start, start + k), this.#range(start + k, end));
  }

  #known(size) {
    if (!isCount(size) || size > this.size) throw new RangeError('the tree has not grown to that size');
  }

  /** The root the list had when it held `size` entries. */
  root(size = this.size) {
    this.#known(size);
    return this.#range(0, size);
  }

  /** Proof that the entry at `index` is in the list of `size` entries: PATH(m, D[n]) of RFC 6962. */
  inclusionProof(index, size = this.size) {
    this.#known(size);
    if (!isCount(index) || index >= size) throw new RangeError('no such entry in a list of that size');
    const path = (m, start, end) => {
      const n = end - start;
      if (n === 1) return [];
      const k = split(n);
      return m < k ? [...path(m, start, start + k), this.#range(start + k, end)] : [...path(m - k, start + k, end), this.#range(start, start + k)];
    };
    return path(index, 0, size);
  }

  /** Proof that the list of `first` entries is the beginning of the list of `second`: PROOF(m, D[n]) of RFC 6962. */
  consistencyProof(first, second = this.size) {
    this.#known(second);
    if (!isCount(first) || first > second) throw new RangeError('the first size is not one the list went through');
    if (first === 0 || first === second) return [];
    const subproof = (m, start, end, whole) => {
      const n = end - start;
      if (m === n) return whole ? [] : [this.#range(start, end)];
      const k = split(n);
      return m <= k ? [...subproof(m, start, start + k, whole), this.#range(start + k, end)] : [...subproof(m - k, start + k, end, false), this.#range(start, start + k)];
    };
    return subproof(first, 0, second, true);
  }
}

// Both checks below follow RFC 9162 step by step, the tests on `sn` included. A proof with a hash
// too many or too few would not come to the root in any case - that would take a collision - but
// the code is kept as the RFC reads, so that it can be held against it line by line.

/**
 * Whether `proof` shows that the entry with hash `leaf` is at `index` in the list of `size`
 * entries whose root is `root`.
 */
export function verifyInclusion({ index, size, leaf, proof, root }) {
  if (!isCount(index) || !isCount(size) || index >= size || !isHash(leaf) || !isHash(root) || !Array.isArray(proof) || !proof.every(isHash)) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (odd(fn) || fn === sn) {
      r = nodeHash(p, r);
      while (!odd(fn) && fn !== 0) {
        fn = half(fn);
        sn = half(sn);
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && r.equals(root);
}

/**
 * Whether `proof` shows that the list of `first` entries with root `firstRoot` is the beginning of
 * the list of `second` entries with root `secondRoot`. An empty list is the beginning of any.
 */
export function verifyConsistency({ first, second, firstRoot, secondRoot, proof }) {
  if (!isCount(first) || !isCount(second) || first > second || !isHash(firstRoot) || !isHash(secondRoot) || !Array.isArray(proof) || !proof.every(isHash)) return false;
  if (first === second) return proof.length === 0 && firstRoot.equals(secondRoot);
  if (first === 0) return proof.length === 0 && firstRoot.equals(EMPTY_ROOT);
  // When the first list is one complete subtree, its root is where the proof starts and is not sent.
  const path = Number.isInteger(Math.log2(first)) ? [firstRoot, ...proof] : proof;
  if (path.length === 0) return false;
  let fn = first - 1;
  let sn = second - 1;
  while (odd(fn)) {
    fn = half(fn);
    sn = half(sn);
  }
  let fr = path[0];
  let sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (odd(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      while (!odd(fn) && fn !== 0) {
        fn = half(fn);
        sn = half(sn);
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && fr.equals(firstRoot) && sr.equals(secondRoot);
}

/**
 * What somebody who reads a list entry by entry keeps of it to know its root: the hash of each
 * complete subtree the list is made of, largest first. For a list of n entries, as many hashes
 * as n has ones in binary.
 */
export class Frontier {
  #hashes;
  #size;

  constructor({ size = 0, hashes = [] } = {}) {
    if (!isCount(size) || !Array.isArray(hashes) || !hashes.every(isHash)) throw new TypeError('a frontier is a size and the hashes of its subtrees');
    let ones = 0;
    for (let n = size; n > 0; n = half(n)) ones += n % 2;
    if (hashes.length !== ones) throw new TypeError('a frontier has one hash for each complete subtree its list is made of');
    this.#size = size;
    this.#hashes = [...hashes];
  }

  get size() {
    return this.#size;
  }

  get hashes() {
    return [...this.#hashes];
  }

  /** Takes in the next entry of the list, given its leaf hash. */
  append(leaf) {
    if (!isHash(leaf)) throw new TypeError('a leaf hash is 32 bytes');
    this.#hashes.push(leaf);
    this.#size += 1;
    // Two subtrees of the same size make one of twice the size: as many times as the new size can be halved.
    for (let n = this.#size; n % 2 === 0; n = half(n)) {
      const right = this.#hashes.pop();
      const left = this.#hashes.pop();
      this.#hashes.push(nodeHash(left, right));
    }
  }

  /** The root of the list read so far. */
  root() {
    if (this.#hashes.length === 0) return EMPTY_ROOT;
    return this.#hashes.slice(0, -1).reduceRight((right, left) => nodeHash(left, right), this.#hashes.at(-1));
  }
}
