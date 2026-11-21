// SPDX-License-Identifier: Apache-2.0
// The map that one hash tells (src/core/statemap.mjs): its root is the one its definition gives,
// however the map came to hold what it holds; a proof shows what it has under one name, or that
// it has nothing there; and nothing else passes for a proof.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EMPTY_STATE, StateMap, stateRoot, verifyState } from '../src/core/statemap.mjs';

const sha256 = (...parts) => parts.reduce((hash, part) => hash.update(part), createHash('sha256')).digest();
const valueOf = (name) => sha256(Buffer.from(`value of ${name}`));
const pathOf = (name) => sha256(Buffer.from(name));
const hex = (bytes) => bytes.toString('hex');
/** A map with those names, each with the value this file gives it. */
const mapOf = (names) => {
  const map = new StateMap();
  for (const name of names) map.set(name, valueOf(name));
  return map;
};
const shuffled = (list, seed) => {
  // The same shuffle every time: a test that fails must fail again.
  const order = list.map((item, i) => [sha256(Buffer.from(`${seed}/${i}`)).readUInt32BE(0), item]);
  return order.sort((one, other) => one[0] - other[0]).map(([, item]) => item);
};
const SIX = ['agent:alice', 'agent:bob', 'instance:laptop', 'topic:dev.rust.news', 'account:acme', 'topic:1849'];

test('the root of a map is the one its definition gives', () => {
  // Worked out by a program that shares nothing with the module (the definition, in Python, with hashlib).
  assert.equal(hex(new StateMap().root), '00'.repeat(32));
  assert.deepEqual(new StateMap().root, EMPTY_STATE);
  assert.equal(hex(mapOf(['agent:alice']).root), '576f67ac2f1078317c659717843ba5bdb3dcc84feffa3323c31a400929aea9d4');
  assert.equal(hex(mapOf(['agent:alice', 'agent:bob']).root), '6473e8d35f1b5879f6366f74f23ddf90d2a8369f1b8a00156e6c640364ac193f');
  // Two names whose paths go the same way for twelve bits: twelve forks with nothing on their other side.
  assert.equal(hex(mapOf(['agent:alice', 'topic:1849']).root), '7ad6cd4f40b8bf5772934c0d5f5112d373042ecb196a31ab416662cfd785751f');
  assert.equal(hex(mapOf(SIX).root), '19613137c2c44fcb6ecc037520a14d22e2f48788d78704584182e9c27a829b24');
  assert.equal(hex(mapOf(Array.from({ length: 100 }, (_, i) => `name ${i}`)).root), '74e18c5dc6fb3b59319ae832385cc1b25ada3cc07cf9d8a8dd4c4eb35f317774');

  // And by hand, for the two smallest: one name is its leaf, two that part at the first bit are one fork.
  const leaf = (name) => sha256(Buffer.from([0]), pathOf(name), valueOf(name));
  assert.deepEqual(mapOf(['agent:alice']).root, leaf('agent:alice'));
  const [first, second] = ['agent:alice', 'agent:bob'].sort((one, other) => (pathOf(one)[0] >> 7) - (pathOf(other)[0] >> 7));
  assert.notEqual(pathOf(first)[0] >> 7, pathOf(second)[0] >> 7);
  assert.deepEqual(mapOf(['agent:alice', 'agent:bob']).root, sha256(Buffer.from([1]), leaf(first), leaf(second)));
});

test('the root tells what the map holds, not how it came to hold it', () => {
  const names = Array.from({ length: 300 }, (_, i) => `agent:did:key:z6Mk${i}`);
  const whole = stateRoot(names.map((name) => [name, valueOf(name)]));
  for (const seed of ['a', 'b', 'c']) assert.deepEqual(mapOf(shuffled(names, seed)).root, whole);
  // A value that changes gives another root, and the one of a map that had it so from the start.
  const map = mapOf(names);
  const changed = sha256(Buffer.from('another value'));
  map.set(names[7], changed);
  assert.notDeepEqual(map.root, whole);
  assert.deepEqual(map.root, stateRoot(names.map((name, i) => [name, i === 7 ? changed : valueOf(name)])));
  map.set(names[7], valueOf(names[7]));
  assert.deepEqual(map.root, whole);
  // Every root on the way is the root of what the map held then.
  const growing = new StateMap();
  const held = [];
  for (const name of shuffled(names, 'd').slice(0, 60)) {
    growing.set(name, valueOf(name));
    held.push([name, valueOf(name)]);
    assert.deepEqual(growing.root, stateRoot(held));
  }
  // The value kept is the one given, not the buffer it came in.
  const mine = Buffer.from(valueOf('x'));
  const kept = new StateMap();
  kept.set('x', mine);
  mine.fill(0);
  assert.deepEqual(kept.prove('x').value, valueOf('x'));
  assert.throws(() => stateRoot([['x', valueOf('x')], ['x', valueOf('y')]]), /once/);
  for (const [name, value] of [[7, valueOf('x')], ['x', 'value'], ['x', Buffer.alloc(31)], ['x', null]]) {
    assert.throws(() => new StateMap().set(name, value), TypeError);
    assert.throws(() => stateRoot([[name, value]]), TypeError);
  }
});

test('a proof shows what the map has under a name', () => {
  const names = Array.from({ length: 500 }, (_, i) => `topic:acme.${i}`);
  const map = mapOf(names);
  for (const name of [names[0], names[250], names[499]]) {
    const { value, proof } = map.prove(name);
    assert.deepEqual(value, valueOf(name));
    assert.equal(verifyState(map.root, name, value, proof), true);
    assert.equal(proof.other, null);
    // As long as the logarithm of the map, give or take: not as long as a path.
    assert.ok(proof.siblings.length >= 5 && proof.siblings.length <= 30, `${proof.siblings.length} hashes`);
    // It travels as JSON and is the same proof on the other side.
    assert.equal(verifyState(map.root, name, value, JSON.parse(JSON.stringify(proof))), true);
  }
  // In a map of one name there is nothing to show but the leaf.
  const one = mapOf(['agent:alice']);
  assert.deepEqual(one.prove('agent:alice').proof, { siblings: [], other: null });
  assert.equal(verifyState(one.root, 'agent:alice', valueOf('agent:alice'), one.prove('agent:alice').proof), true);
});

test('a proof shows that the map has nothing under a name', () => {
  const map = mapOf(SIX);
  const ends = new Set();
  for (let i = 0; i < 200; i++) {
    const name = `agent:nobody-${i}`;
    const { value, proof } = map.prove(name);
    assert.equal(value, null);
    assert.equal(verifyState(map.root, name, null, proof), true, name);
    ends.add(proof.other === null ? 'nothing' : 'another name');
  }
  // Where the name would be there is nothing, or another name alone: both happen.
  assert.deepEqual([...ends].sort(), ['another name', 'nothing']);
  // An empty map has nothing under any name, and says so with an empty proof.
  const empty = new StateMap();
  assert.deepEqual(empty.prove('agent:alice'), { value: null, kept: undefined, proof: { siblings: [], other: null } });
  assert.equal(verifyState(empty.root, 'agent:alice', null, empty.prove('agent:alice').proof), true);
});

test('for one root there is one answer about a name', () => {
  const map = mapOf(SIX);
  const there = 'agent:alice';
  const { value, proof } = map.prove(there);
  const missing = 'agent:mallory';
  const absent = map.prove(missing).proof;

  // Another value, or nothing, where there is one.
  assert.equal(verifyState(map.root, there, valueOf('agent:bob'), proof), false);
  assert.equal(verifyState(map.root, there, null, proof), false);
  // Something where there is nothing: with the proof of nothing, and with the proof of a name that is there.
  assert.equal(verifyState(map.root, missing, valueOf(missing), absent), false);
  assert.equal(verifyState(map.root, missing, valueOf(missing), { ...absent, other: null }), false);
  assert.equal(verifyState(map.root, missing, value, proof), false);
  // The proof of one name does not do for another, nor under the root of another map.
  assert.equal(verifyState(map.root, 'agent:bob', valueOf('agent:bob'), proof), false);
  assert.equal(verifyState(mapOf(SIX.slice(1)).root, there, value, proof), false);
  assert.equal(verifyState(EMPTY_STATE, there, value, proof), false);
  // A map that moved on: what was shown before is not shown of the new root.
  const before = map.root;
  map.set(there, valueOf('agent:bob'));
  assert.equal(verifyState(map.root, there, value, proof), false);
  assert.equal(verifyState(before, there, value, proof), true);
  assert.equal(verifyState(map.root, there, valueOf('agent:bob'), map.prove(there).proof), true);
});

test('nothing else passes for a proof', () => {
  const names = Array.from({ length: 64 }, (_, i) => `instance:${i}`);
  const map = mapOf(names);
  const there = names[3];
  const { value, proof } = map.prove(there);
  assert.ok(proof.siblings.length >= 2);
  const passes = (given, name = there, said = value) => verifyState(map.root, name, said, given);
  assert.equal(passes(proof), true);

  // One hash changed, dropped, added or moved.
  const flipped = (hash) => (hash.startsWith('0') ? `1${hash.slice(1)}` : `0${hash.slice(1)}`);
  proof.siblings.forEach((hash, i) => assert.equal(passes({ ...proof, siblings: proof.siblings.with(i, flipped(hash)) }), false, `sibling ${i}`));
  assert.equal(passes({ ...proof, siblings: proof.siblings.slice(1) }), false);
  assert.equal(passes({ ...proof, siblings: proof.siblings.slice(0, -1) }), false);
  assert.equal(passes({ ...proof, siblings: [...proof.siblings, hex(EMPTY_STATE)] }), false);
  assert.equal(passes({ ...proof, siblings: [...proof.siblings].reverse() }), proof.siblings.length < 2);

  // "Nothing is there, another name is": the other name has to be another, and where this one would be.
  const missing = Array.from({ length: 400 }, (_, i) => `instance:none-${i}`).find((name) => map.prove(name).proof.other !== null);
  const absent = map.prove(missing).proof;
  assert.equal(passes(absent, missing, null), true);
  // The leaf of the name itself, given as "another": it would show a name that is there to be missing.
  assert.equal(passes({ siblings: proof.siblings, other: { path: hex(pathOf(there)), value: hex(value) } }, there, null), false);
  // The leaf of a name from elsewhere in the tree, with the hashes that lead to it: true of that name, and no proof for this one.
  const elsewhere = names.find((name) => (pathOf(name)[0] >> 7) !== (pathOf(missing)[0] >> 7));
  const real = map.prove(elsewhere);
  assert.equal(passes({ siblings: real.proof.siblings, other: { path: hex(pathOf(elsewhere)), value: hex(real.value) } }, missing, null), false);
  // A fork given as if it were the leaf of another name, or as if it were nothing.
  assert.equal(passes({ siblings: absent.siblings.slice(0, -1), other: null }, missing, null), false);
  assert.equal(passes({ siblings: absent.siblings, other: { ...absent.other, value: flipped(absent.other.value) } }, missing, null), false);
  assert.equal(passes({ siblings: absent.siblings, other: null }, missing, null), false);

  // A proof says one thing in one way: nothing rides along in it, and its hashes are written one way.
  const beside = { path: absent.other.path, value: absent.other.value };
  assert.equal(passes({ ...proof, other: beside }), false, 'a value, with the leaf of another name beside it');
  assert.equal(passes({ ...proof, more: 1 }), false);
  assert.equal(passes({ ...absent, other: { ...absent.other, more: 1 } }, missing, null), false);
  const shouted = proof.siblings.map((hash) => hash.toUpperCase());
  assert.notDeepEqual(shouted, proof.siblings);
  assert.equal(passes({ ...proof, siblings: shouted }), false);
  assert.equal(passes({ ...absent, other: { ...absent.other, path: absent.other.path.toUpperCase() } }, missing, null), absent.other.path.toUpperCase() === absent.other.path);

  // What is not a proof at all shows nothing, and breaks nothing.
  const HASH = hex(EMPTY_STATE);
  const notProofs = [
    null, undefined, 'proof', 7, [], {}, { siblings: [] }, { other: null }, { siblings: 'none', other: null }, { siblings: [], other: null, more: 1 },
    { siblings: [HASH.slice(2)], other: null }, { siblings: [HASH.toUpperCase().replace(/0/g, 'A')], other: null }, { siblings: [Buffer.alloc(32)], other: null }, { siblings: [null], other: null },
    { siblings: Array(257).fill(HASH), other: null },
    { siblings: [], other: {} }, { siblings: [], other: { path: HASH } }, { siblings: [], other: { path: HASH, value: 'x' } }, { siblings: [], other: { path: HASH, value: HASH, more: 1 } }, { siblings: [], other: 'x' },
  ];
  for (const given of notProofs) assert.equal(passes(given), false, JSON.stringify(given)?.slice(0, 60));
  assert.equal(verifyState(hex(map.root), there, value, proof), false, 'a root in hex is not a root');
  assert.equal(verifyState(map.root, 7, value, proof), false);
  assert.equal(verifyState(map.root, there, hex(value), proof), false);
  assert.equal(verifyState(Buffer.alloc(31), there, value, proof), false);
  // As deep as a path can go, a proof is still only as good as its hashes.
  assert.equal(passes({ siblings: Array(256).fill(HASH), other: null }), false);
});

test('a view of the map proves what it had then, after the map has moved on', () => {
  const map = mapOf(SIX);
  const then = map.view();
  map.set('agent:alice', valueOf('revoked'));
  map.set('agent:carol', valueOf('agent:carol'));
  assert.deepEqual(then.root, mapOf(SIX).root);
  assert.notDeepEqual(map.root, then.root);
  // What it had under a name, and what it did not have yet.
  const was = then.prove('agent:alice');
  assert.deepEqual(was.value, valueOf('agent:alice'));
  assert.equal(verifyState(then.root, 'agent:alice', was.value, was.proof), true);
  const notYet = then.prove('agent:carol');
  assert.equal(notYet.value, null);
  assert.equal(verifyState(then.root, 'agent:carol', null, notYet.proof), true);
  // What the caller asked to have kept with a value comes back with it, as it was then: it is no part of the tree.
  const noted = new StateMap();
  noted.set('agent:alice', valueOf('agent:alice'), '{"status":"active"}');
  const earlier = noted.view();
  noted.set('agent:alice', valueOf('revoked'), '{"status":"revoked"}');
  assert.deepEqual([earlier.prove('agent:alice').kept, noted.prove('agent:alice').kept, noted.prove('agent:bob').kept], ['{"status":"active"}', '{"status":"revoked"}', undefined]);
  assert.deepEqual(earlier.root, mapOf(['agent:alice']).root);
  // And now.
  const now = map.prove('agent:carol');
  assert.equal(verifyState(map.root, 'agent:carol', now.value, now.proof), true);
  assert.equal(verifyState(then.root, 'agent:carol', now.value, now.proof), false);
});

test('a map of tens of thousands of names is made, and asked, in no time worth the name', () => {
  const map = new StateMap();
  const started = performance.now();
  for (let i = 0; i < 20_000; i++) map.set(`agent:did:key:z6Mk${i}`, valueOf(String(i % 50)));
  const made = performance.now() - started;
  const { value, proof } = map.prove('agent:did:key:z6Mk12345');
  assert.equal(verifyState(map.root, 'agent:did:key:z6Mk12345', value, proof), true);
  assert.ok(proof.siblings.length <= 40, `${proof.siblings.length} hashes for one of 20,000 names`);
  assert.ok(made < 5000, `${Math.round(made)} ms to put 20,000 names in`);
});
