# SPDX-License-Identifier: Apache-2.0
# Mutations of: the map that one hash tells: its tree and its proofs (section 34).
# Run from anywhere: python3 experiments/mutations/statemap.py [text of one description]
from harness import run

M = 'src/core/statemap.mjs'
mutations = [
    (M, "    if (proof.other !== null) return false;\n    hash = sha256(LEAF, path, value);", "    hash = sha256(LEAF, path, value);", 'a value shown with the leaf of another name beside it'),
    (M, "    if (other.equals(path)) return false;\n", "", 'the name itself given as another'),
    (M, "      HEX_RE.test(proof.other.path) &&\n", "", 'the path of another name written any way'),
    (M, "const NODE = Buffer.from([0x01]);", "const NODE = Buffer.from([0x00]);", 'a leaf and a fork hashed alike'),
    (M, "const bit = (path, depth) => (path[depth >> 3] >> (7 - (depth & 7))) & 1;", "const bit = (path, depth) => (path[depth >> 3] >> (depth & 7)) & 1;", 'bits taken from the other end'),
    (M, "  Object.keys(proof).length === 2 &&\n  Array.isArray", "  Array.isArray", 'a proof with more in it'),
    (M, "      Object.keys(proof.other ?? {}).length === 2 &&\n", "", 'another name with more in it'),
    (M, "return part.path.equals(leaf.path) ? leaf : apart(part, leaf, depth);", "return part.path.equals(leaf.path) ? part : apart(part, leaf, depth);", 'a value that does not change'),
    (M, "  if (here !== there) return here ? forkOf(other, one) : forkOf(one, other);", "  if (here !== there) return here ? forkOf(one, other) : forkOf(other, one);", 'the two sides of a fork swapped'),
    (M, "  return here ? forkOf(null, below) : forkOf(below, null);", "  return below;", 'forks with nothing on the other side left out'),
    (M, "  return hash.equals(root);\n}", "  return true;\n}", 'any proof passes'),
    (M, "    const top = this.#top;\n    return { root: hashOf(top), prove: (name) => proveIn(top, name) };", "    return { root: hashOf(this.#top), prove: (name) => proveIn(this.#top, name) };", 'a view that moves with the map'),
    (M, "leafOf(pathOf(name), Buffer.from(value), kept)", "leafOf(pathOf(name), value, kept)", 'the buffer of the caller kept'),
    (M, "    hash = bit(path, level) ? sha256(NODE, sibling, hash) : sha256(NODE, hash, sibling);", "    hash = sha256(NODE, hash, sibling);", 'every step folded on the same side'),
    (M, "  } else if (proof.other === null) {\n    hash = EMPTY_STATE;", "  } else if (proof.other === null) {\n    hash = sha256(LEAF, path, EMPTY_STATE);", 'nothing hashed as a leaf'),
    (M, "  proof.siblings.every((hash) => typeof hash === 'string' && HEX_RE.test(hash)) &&", "  proof.siblings.every((hash) => typeof hash === 'string') &&", 'siblings that are not hashes'),
    (M, "    if (seen.has(name)) throw new TypeError('a name is in a map once');\n", "", 'a name twice in the definition'),
    (M, "    if (list.length === 1) return sha256(LEAF, list[0].path, list[0].value);\n", "", 'the definition without its short cut'),
]

run(mutations, ['test/statemap.test.mjs'])
