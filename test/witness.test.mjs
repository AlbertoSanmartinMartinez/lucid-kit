// SPDX-License-Identifier: Apache-2.0
// Checkpoints and cosignatures as C2SP writes them (core/note.mjs), and what a witness does with a
// log that asks it to cosign (core/witness.mjs, src/witness/): it cosigns a log that only grows, and
// nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as edVerify } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSignatures, checkpointText, cosign, formatNote, formatVerifier, NOTE_COSIGNATURE, NOTE_ED25519, parseCheckpoint, parseNote, parseSignatures, parseVerifier, publicKeyBytes, publicKeyFromBytes, signNoteText } from '../src/core/note.mjs';
import { formatAddCheckpoint, parseAddCheckpoint } from '../src/core/witness.mjs';
import { EMPTY_ROOT, leafHash, MerkleTree } from '../src/core/merkle.mjs';
import { generateIdentity, publicKeyBytesFromDid } from '../src/core/didkey.mjs';
import { createWitness, logVerifier } from '../src/witness/server.mjs';
import { createHub } from '../src/hub/server.mjs';
import { AgentClient, LogError, memoryStateStore } from '../src/sdk/index.mjs';
import { LogFollower } from '../src/sdk/follower.mjs';
import { startHub } from './helpers.mjs';

const DASH = '—';

/** A log of `size` entries of its own making, and the hub key it is signed with. */
function aLog(label = 'entry') {
  const identity = generateIdentity();
  const tree = new MerkleTree();
  const signer = { name: identity.did, privateKey: identity.privateKey, key: publicKeyBytesFromDid(identity.did) };
  return {
    did: identity.did,
    tree,
    signer,
    grow(to) {
      while (tree.size < to) tree.append(leafHash(Buffer.from(`${label} ${tree.size}`)));
      return this;
    },
    /** Its checkpoint at `size`, as the note it sends. */
    note(size = tree.size, { root = tree.root(size), by = signer } = {}) {
      const text = checkpointText({ origin: identity.did, size, root });
      return formatNote(text, [signNoteText(text, by)]);
    },
    request(old, size = tree.size, more = {}) {
      return formatAddCheckpoint({ old, proof: more.proof ?? (old === 0 ? [] : tree.consistencyProof(old, size)), note: more.note ?? this.note(size, more) });
    },
  };
}

async function startWitness(t, options) {
  const witness = await createWitness({ port: 0, quiet: true, ...options }).listen();
  t.after(() => witness.close());
  const ask = async (body) => {
    const res = await fetch(`${witness.url}/add-checkpoint`, { method: 'POST', body });
    return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
  };
  /** The answer to a request, in short: the status, and with a 200 how many cosignatures of this witness verify on that checkpoint. */
  const answer = async (body) => {
    const got = await ask(body);
    if (got.status !== 200) return got.status === 409 ? [409, got.body, got.type] : got.status;
    const { text } = parseAddCheckpoint(body);
    return [200, checkSignatures(text, parseSignatures(got.body), { witnesses: [parseVerifier(witness.verifier)] }).cosigned.length];
  };
  return { witness, ask, answer };
}

test('a note is read and checked as c2sp.org/signed-note writes one', () => {
  // The example of the specification: its verifier key, and the note it verifies.
  const vkey = 'example.com/foo+530d903a+AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2k';
  const note = `This is an example message.\n\n${DASH} example.com/foo Uw2QOkn8srV1yJGh2VYRlL1Tnagv1YEq6TfXppzi2ONncAlTgK7Ztg1ERYNZXsYjOBH3mFXmRKuwHjG1Yu72IneyaQM=\n`;
  const verifier = parseVerifier(vkey);
  assert.deepEqual([verifier.name, verifier.type, verifier.id.toString('hex'), verifier.key.length], ['example.com/foo', NOTE_ED25519, '530d903a', 32]);
  assert.equal(formatVerifier(verifier), vkey);
  const { text, signatures } = parseNote(note);
  assert.equal(text, 'This is an example message.\n');
  assert.deepEqual(checkSignatures(text, signatures, { log: verifier }), { byLog: true, cosigned: [] });
  assert.equal(formatNote(text, signatures), note);

  // A known key that does not verify makes the note worthless; a key nobody knows is passed over.
  assert.throws(() => checkSignatures('This is an example massage.\n', signatures, { log: verifier }), /does not verify/);
  const stranger = { name: 'example.com/bar', type: NOTE_ED25519, key: verifier.key };
  assert.deepEqual(checkSignatures(text, signatures, { log: { ...stranger, id: parseVerifier(formatVerifier(stranger)).id } }), { byLog: false, cosigned: [] });
  // The same name with another key is another key: its id differs, and the line is not its.
  const other = publicKeyBytes(generateKeyPairSync('ed25519').publicKey);
  assert.deepEqual(checkSignatures(text, signatures, { log: parseVerifier(formatVerifier({ name: 'example.com/foo', type: NOTE_ED25519, key: other })) }), { byLog: false, cosigned: [] });

  // How a note and a verifier key are written is held to.
  for (const bad of [
    note.slice(0, -1), // no final newline
    note.replace('\n\n', '\n'), // no blank line
    note.replace(`${DASH} `, '- '), // a hyphen for the dash
    note.replace('IneyaQM=', 'IneyaQN='), // base64 that is not canonical
    note.replace('example.com/foo U', 'example.com/foo  U'),
    `\n\n${DASH} example.com/foo AAAAAAA=\n`,
    `text\u0007\n\n${DASH} example.com/foo Uw2QOkn8srV1yJGh2VYRlL1Tnagv1YEq6TfXppzi2ONncAlTgK7Ztg1ERYNZXsYjOBH3mFXmRKuwHjG1Yu72IneyaQM=\n`,
    `text\n\n${`${DASH} k AAAAAAA=\n`.repeat(33)}`,
    7,
  ]) {
    assert.throws(() => parseNote(bad), TypeError, JSON.stringify(bad).slice(0, 60));
  }
  for (const bad of ['example.com/foo+530d903b+AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2k', 'example.com/foo+530d903a', 'exa mple+530d903a+AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2k', 'example.com/foo+530d903a+AekyeRrm56hApGFkyQR4ZCbV54Id2LKaANYcrnKv3U2', null]) {
    assert.throws(() => parseVerifier(bad), TypeError, String(bad));
  }
});

test('a checkpoint and a cosignature are the lines c2sp.org writes', () => {
  // The example of c2sp.org/tlog-checkpoint.
  const text = 'example.com/behind-the-sofa\n20852163\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n';
  const checkpoint = parseCheckpoint(text);
  assert.deepEqual([checkpoint.origin, checkpoint.size, checkpoint.root.toString('base64'), checkpoint.extensions], ['example.com/behind-the-sofa', 20852163, 'CsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=', []]);
  assert.equal(checkpointText(checkpoint), text);
  for (const bad of [
    'example.com/log\n01\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n',
    'example.com/log\n-1\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n',
    'example.com/log\n1\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I\n',
    'example.com/log\n1\nAAAA\n',
    'example.com/log\n1\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n\nextension\n',
    'example.com/log\n1\n',
    'exa mple\n1\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n',
    'example.com/log\n1\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=',
  ]) {
    assert.throws(() => parseCheckpoint(bad), TypeError, JSON.stringify(bad));
  }

  // What a witness signs is what c2sp.org/tlog-cosignature says: these lines, for that time.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const witness = { name: 'witness.example/w1', privateKey, key: publicKeyBytes(publicKey) };
  const line = cosign(text, witness, 1679315147);
  const signedOver = 'cosignature/v1\ntime 1679315147\nexample.com/behind-the-sofa\n20852163\nCsUYapGGPo4dkMgIAUqom/Xajj7h2fB2MPA3j2jxq2I=\n';
  assert.equal(line.signature.length, 72);
  assert.equal(line.signature.readBigUInt64BE(0), 1679315147n);
  assert.equal(edVerify(null, Buffer.from(signedOver), publicKeyFromBytes(witness.key), line.signature.subarray(8)), true);
  const known = parseVerifier(formatVerifier({ name: witness.name, type: NOTE_COSIGNATURE, key: witness.key }));
  assert.deepEqual(checkSignatures(text, [line], { witnesses: [known] }).cosigned, [{ name: 'witness.example/w1', time: 1679315147 }]);

  // A cosignature is for one checkpoint and one time, and is not the signature of a log.
  const grown = text.replace('20852163', '20852164');
  assert.throws(() => checkSignatures(grown, [line], { witnesses: [known] }), /does not verify/);
  const moved = { ...line, signature: Buffer.concat([Buffer.from('0000000064182a8c', 'hex'), line.signature.subarray(8)]) };
  assert.throws(() => checkSignatures(text, [moved], { witnesses: [known] }), /does not verify/);
  assert.deepEqual(checkSignatures(text, [line], { log: parseVerifier(formatVerifier({ name: witness.name, type: NOTE_ED25519, key: witness.key })) }), { byLog: false, cosigned: [] });
  // Signed by the same key as a plain note, it is no cosignature: what a witness signs says so in its first line.
  const plain = { ...signNoteText(text, witness), id: line.id };
  assert.throws(() => checkSignatures(text, [plain], { witnesses: [known] }), /does not verify/);
  // The latest of a witness counts, once.
  assert.deepEqual(checkSignatures(text, [cosign(text, witness, 5), cosign(text, witness, 9), cosign(text, witness, 7)], { witnesses: [known] }).cosigned, [{ name: 'witness.example/w1', time: 9 }]);
});

test('a witness cosigns a log that grows, and tells one that asks from the wrong place where it is', async (t) => {
  const log = aLog().grow(5);
  const { witness, ask, answer } = await startWitness(t, { logs: [log.did] });
  assert.equal(witness.latest(log.did), null);

  // The first time there is nothing to follow from.
  assert.deepEqual(await answer(log.request(0, 5)), [200, 1]);
  assert.deepEqual([witness.latest(log.did).size, witness.latest(log.did).root.equals(log.tree.root(5))], [5, true]);
  // It grew: the proof says the five are the beginning of the nine.
  log.grow(9);
  assert.deepEqual(await answer(log.request(5, 9)), [200, 1]);
  // Nothing new: the same log, cosigned again for now.
  const again = await ask(log.request(9, 9));
  assert.equal(again.status, 200);
  assert.match(again.body, new RegExp(`^${DASH} ${witness.name.replace('/', '\\/')} [A-Za-z0-9+/=]+\n$`));

  // A log that does not know where the witness is, is told: the size, and nothing else.
  assert.deepEqual(await answer(log.request(0, 9)), [409, '9\n', 'text/x.tlog.size']);
  assert.deepEqual(await answer(log.request(5, 9)), [409, '9\n', 'text/x.tlog.size']);
  log.grow(12);
  assert.deepEqual(await answer(log.request(9, 12)), [200, 1]);
  assert.equal(witness.latest(log.did).size, 12);

  // Two that come at once from the same place: the second is judged against what the first left.
  log.grow(20);
  const both = await Promise.all([answer(log.request(12, 15)), answer(log.request(12, 20))]);
  assert.deepEqual(both.map((got) => got[0]).sort(), [200, 409]);
  assert.ok([15, 20].includes(witness.latest(log.did).size));

  // Who it is, for whoever has to trust it.
  const info = await (await fetch(`${witness.url}/v1/info`)).json();
  assert.deepEqual(info, { name: witness.name, verifier: witness.verifier, logs: [log.did] });
  assert.equal(parseVerifier(witness.verifier).type, NOTE_COSIGNATURE);
});

test('a witness cosigns nothing that does not follow from what it cosigned before', async (t) => {
  const log = aLog().grow(8);
  const { witness, answer } = await startWitness(t, { logs: [log.did] });
  assert.deepEqual(await answer(log.request(0, 8)), [200, 1]);
  const held = () => [witness.latest(log.did).size, witness.latest(log.did).root.toString('hex')];
  const before = held();

  // The same hub with another list: another eight entries, or twelve that do not begin with the eight.
  const fork = aLog('another').grow(12);
  const forked = (size) => ({ root: fork.tree.root(size) });
  assert.equal(await answer(log.request(8, 8, forked(8))), 422);
  assert.equal(await answer(log.request(8, 12, { ...forked(12), proof: fork.tree.consistencyProof(8, 12) })), 422);
  assert.equal(await answer(log.request(8, 12, { ...forked(12), proof: [] })), 422);
  // The real one with a proof that is not its own, or with none.
  log.grow(12);
  assert.equal(await answer(log.request(8, 12, { proof: fork.tree.consistencyProof(8, 12) })), 422);
  assert.equal(await answer(log.request(8, 12, { proof: [] })), 422);
  // Going back: fewer entries than it cosigned.
  assert.equal(await answer(log.request(8, 6, { proof: [] })), 400);
  assert.deepEqual(await answer(log.request(6, 6)), [409, '8\n', 'text/x.tlog.size']);
  assert.deepEqual(await answer(log.request(0, 6)), [409, '8\n', 'text/x.tlog.size']);
  assert.deepEqual(held(), before, 'none of that moved what the witness holds');

  // Not signed by the log: by somebody else under its name, by nobody, or with a signature that does not verify.
  const mallory = generateIdentity();
  const theirs = { name: log.did, privateKey: mallory.privateKey, key: publicKeyBytesFromDid(mallory.did) };
  assert.equal(await answer(log.request(8, 12, { by: theirs })), 403);
  const text = checkpointText({ origin: log.did, size: 12, root: log.tree.root(12) });
  const forgedLine = { ...signNoteText(text, theirs), id: signNoteText(text, log.signer).id };
  assert.equal(await answer(log.request(8, 12, { note: formatNote(text, [forgedLine]) })), 403);
  // A log it was not told to watch, even if it is a log.
  const stranger = aLog().grow(3);
  assert.equal(await answer(stranger.request(0, 3)), 404);
  // An empty log has the root of an empty one, and from nothing no proof is taken.
  const fresh = aLog().grow(4);
  const second = await startWitness(t, { logs: [fresh.did] });
  assert.equal(await second.answer(fresh.request(0, 0, { root: fresh.tree.root(4) })), 422);
  assert.equal(await second.answer(fresh.request(0, 4, { proof: [fresh.tree.root(2)] })), 422);
  assert.deepEqual(await second.answer(fresh.request(0, 0, { root: EMPTY_ROOT })), [200, 1]);
  assert.deepEqual(await second.answer(fresh.request(0, 4)), [200, 1]);

  // What is not written as a request.
  const good = log.request(8, 12);
  for (const bad of ['', 'old 8\n', good.replace('old 8', 'old 08'), good.replace('old 8', 'new 8'), good.replace('old 8\n', 'old 8\nnot-a-hash\n'), `old 8\n${'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n'.repeat(64)}\n${log.note(12)}`, good.replace(`${log.did}\n12`, `${log.did}\n012`)]) {
    assert.equal(await answer(bad), 400, JSON.stringify(bad).slice(0, 50));
  }
  assert.equal((await second.ask('x'.repeat(17 * 1024))).status, 413);
  assert.equal((await fetch(`${witness.url}/add-checkpoint`)).status, 404);
  assert.deepEqual(held(), before);
  // And the log it watches, when it does follow, is still cosigned.
  assert.deepEqual(await answer(good), [200, 1]);
});

test('a witness remembers what it cosigned, and is told which logs it watches', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-witness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = aLog().grow(6);
  const first = await createWitness({ port: 0, quiet: true, dataDir: dir, logs: [log.did], name: 'witness.example/w1' }).listen();
  const post = async (witness, body) => (await fetch(`${witness.url}/add-checkpoint`, { method: 'POST', body })).status;
  assert.equal(await post(first, log.request(0, 6)), 200);
  await first.close();

  // Stopped and started: the same key, and the same record. From nothing it would have cosigned anything again.
  const second = await createWitness({ port: 0, quiet: true, dataDir: dir, logs: [log.did], name: 'witness.example/w1' }).listen();
  t.after(() => second.close());
  assert.equal(second.verifier, first.verifier);
  assert.match(second.verifier, /^witness\.example\/w1\+[0-9a-f]{8}\+/);
  assert.equal(second.latest(log.did).size, 6);
  assert.equal(await post(second, aLog('another').grow(9).request(0, 9)), 404);
  const fork = aLog('another').grow(9);
  assert.equal(await post(second, log.request(0, 6)), 409, 'it is not at nothing: it is where it was');
  assert.equal(await post(second, log.request(6, 6)), 200, 'what it holds, again');
  assert.equal(await post(second, log.request(6, 9, { root: fork.tree.root(9), proof: fork.tree.consistencyProof(6, 9) })), 422);
  log.grow(9);
  assert.equal(await post(second, log.request(6, 9)), 200);

  // A log is given by the DID of its hub or by the key it signs with, never by a witness's key.
  const key = publicKeyBytes(generateKeyPairSync('ed25519').publicKey);
  assert.equal(logVerifier(formatVerifier({ name: 'log.example/a', type: NOTE_ED25519, key })).name, 'log.example/a');
  assert.deepEqual([logVerifier(log.did).name, logVerifier(log.did).type], [log.did, NOTE_ED25519]);
  assert.throws(() => logVerifier(formatVerifier({ name: 'witness.example/w', type: NOTE_COSIGNATURE, key })), TypeError);
  assert.throws(() => createWitness({ port: 0, quiet: true, logs: [] }), /which logs/);
  assert.throws(() => createWitness({ port: 0, quiet: true, logs: ['not a log'] }), TypeError);
});

// ------------------------------------------------------------------------------ a hub and its witnesses

const HOUR = 3_600_000;
/** What a follower reads of a hub with, here: plain requests, and `over` to answer some of them with something else. */
const reading = (hub, over = () => null) => {
  const get = async (path, as) => {
    const res = (await over(path)) ?? (await fetch(hub.url + path));
    if (!res.ok) throw Object.assign(new Error(`the hub answered ${res.status}`), { status: res.status });
    return as === 'text' ? res.text() : res.json();
  };
  return { read: (path) => get(path, 'json'), readText: (path) => get(path, 'text') };
};
const followerOf = (hub, options, over) => new LogFollower({ ...reading(hub, over), store: memoryStateStore(), ...options });
const refusal = (promise) => promise.then(() => 'taken', (err) => (err instanceof LogError ? err.code : `${err.name}: ${err.message}`));
const watched = (hub, ...witnesses) => ({ identity: hub, witnesses: witnesses.map((witness) => `${witness.verifier}@${witness.url}`), witnessIntervalMs: HOUR });
const noteOf = async (hub) => {
  const res = await fetch(`${hub.url}/v1/log/note`);
  return res.ok ? parseNote(await res.text()) : (await res.json()).error.code;
};

test('a hub shows its log to its witnesses, and a client that asks for them takes the log they cosigned', async (t) => {
  const key = generateIdentity();
  const [w1, w2] = [(await startWitness(t, { logs: [key.did] })).witness, (await startWitness(t, { logs: [key.did], name: 'witness.example/second' })).witness];
  const hub = await startHub(t, watched(key, w1, w2));
  assert.equal(await hub.witnessNow(), 2);
  const both = { witnesses: [w1.verifier, w2.verifier] };

  // An agent that asks for both witnesses registers and works: each thing the hub shows it is held to a log they cosigned.
  const alice = await hub.agent('alice', generateIdentity(), both);
  const bob = await hub.agent('bob', generateIdentity(), both);
  assert.equal((await alice.getAgent(bob.did)).card.name, 'bob');
  assert.equal(alice.followedHub, hub.did);

  // What the hub shows: its checkpoint as C2SP writes one, signed by it and cosigned by the two.
  assert.equal(await hub.witnessNow(), 2);
  const { text, signatures } = await noteOf(hub);
  const checkpoint = parseCheckpoint(text);
  assert.deepEqual([checkpoint.origin, checkpoint.size, checkpoint.root.equals(hub.store.logHead().root)], [hub.did, hub.store.log.length, true]);
  const known = { log: logVerifier(hub.did), witnesses: [parseVerifier(w1.verifier), parseVerifier(w2.verifier)] };
  const seen = checkSignatures(text, signatures, known);
  assert.deepEqual([seen.byLog, seen.cosigned.map(({ name }) => name).sort()], [true, [w1.name, 'witness.example/second'].sort()]);
  assert.deepEqual((await (await fetch(`${hub.url}/v1/info`)).json()).log.witnesses, [w1.verifier, w2.verifier]);
  assert.equal(w1.latest(hub.did).size, hub.store.log.length);

  // The log goes on and the last entries are not cosigned yet: what was cosigned is where it begins, and that is enough.
  await bob.updateCard({ name: 'bob', description: 'changed after the witnesses looked' });
  assert.ok(hub.store.log.length > checkpoint.size);
  assert.equal((await alice.getAgent(bob.did)).card.description, 'changed after the witnesses looked');
  const follower = followerOf(hub, both);
  assert.ok((await follower.directory()).agents.has(bob.did));
  assert.deepEqual([follower.size, follower.witnessedSize], [hub.store.log.length, checkpoint.size]);
  // At the next round they are.
  assert.equal(await hub.witnessNow(), 2);
  await follower.directory({ fresh: true });
  assert.equal(follower.witnessedSize, hub.store.log.length);

  // Nothing new in the log: the witnesses still say, each round, that this is all there is.
  const before = Math.max(...checkSignatures(...Object.values(await noteOf(hub)), known).cosigned.map(({ time }) => time));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await hub.witnessNow(), 2);
  const after = checkSignatures(...Object.values(await noteOf(hub)), known).cosigned.map(({ time }) => time);
  assert.ok(Math.min(...after) > before, 'cosigned again, for now');

  // One witness gone: the hub keeps what the other cosigns. A client that asked for one of the two goes on;
  // one that asked for both does, until what the missing one cosigned is too old to count.
  await w2.close();
  assert.equal(await hub.witnessNow(), 1);
  assert.equal(await refusal(followerOf(hub, { ...both, quorum: 1 }).directory()), 'taken');
  assert.equal(await refusal(followerOf(hub, both).directory()), 'log_unwitnessed');
  assert.equal(await refusal(followerOf(hub, { witnesses: [w1.verifier] }).directory()), 'taken');
  assert.equal(await refusal(followerOf(hub, { witnesses: [w2.verifier] }).directory()), 'log_unwitnessed');
  const later = (ms) => ({ now: () => Date.now() + ms });
  assert.equal(await refusal(followerOf(hub, { ...both, quorum: 1, ...later(4 * 60_000) }).directory()), 'taken');
  assert.equal(await refusal(followerOf(hub, { ...both, quorum: 1, ...later(6 * 60_000) }).directory()), 'log_unwitnessed');
  assert.equal(await refusal(followerOf(hub, { ...both, quorum: 1, witnessMaxAgeMs: HOUR, ...later(6 * 60_000) }).directory()), 'taken');
  // A cosignature from further ahead than clocks differ is not from now either.
  assert.equal(await refusal(followerOf(hub, { ...both, quorum: 1, ...later(-10 * 60_000) }).directory()), 'log_unwitnessed');
  // And the agents that asked for both stop taking the hub's word, rather than going on without them.
  await assert.rejects(followerOf(hub, both).directory(), /1 of the witnesses this client trusts cosigned the log of the hub lately, and it asks for 2/);
});

test('a hub that keeps two logs gets one of them cosigned, and a client that asks for witnesses takes no other', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-fork-'));
  const key = generateIdentity();
  const { witness } = await startWitness(t, { logs: [key.did] });
  const asking = { witnesses: [witness.verifier] };
  const config = { ...watched(key, witness), powDifficulty: 8, quiet: true, port: 0 };

  // One hub, with what everybody has seen so far.
  let running = await createHub({ ...config, dataDir: join(dir, 'one') }).listen();
  t.after(() => running?.close());
  const early = new AgentClient({ hubUrl: running.url, identity: generateIdentity() });
  await early.register({ name: 'early' });
  await early.close();
  assert.equal(await running.witnessNow(), 1);
  const shared = running.store.log.length;
  const oldNote = await (await fetch(`${running.url}/v1/log/note`)).text();
  await running.close();
  running = null;
  cpSync(join(dir, 'one'), join(dir, 'two'), { recursive: true });

  // From there, the same hub twice over: one list for most readers, another for the one it means to deceive.
  const main = await startHub(t, { ...watched(key, witness), dataDir: join(dir, 'one') });
  const fork = await startHub(t, { ...watched(key, witness), dataDir: join(dir, 'two') });
  t.after(() => rmSync(dir, { recursive: true, force: true })); // after the hubs that write there have closed
  assert.equal(main.did, fork.did);
  // So far they are one log, the one that was cosigned, and each is cosigned as that.
  assert.deepEqual([await main.witnessNow(), await fork.witnessNow()], [1, 1]);
  await main.agent('honest');
  const victim = await fork.agent('payments (the real one)');
  assert.equal(main.store.log.length, fork.store.log.length);
  assert.equal(main.store.logHead().root.equals(fork.store.logHead().root), false);

  // The witness cosigns the first that comes, and then only what follows from it.
  assert.equal(await main.witnessNow(), 1);
  assert.equal(await fork.witnessNow(), 0);
  // The hub shows the deceived reader its second list with what the witness cosigned of the first: as
  // many entries, and not those; and then fewer than the second list has, and not its beginning.
  const withNoteOf = (other) => (path) => (path === '/v1/log/note' ? fetch(other.url + path) : null);
  const notTheSame = /^what the witnesses cosigned is not the log the hub shows this client$/;
  await assert.rejects(followerOf(fork, asking, withNoteOf(main)).directory(), (err) => err.code === 'log_invalid' && notTheSame.test(err.message));
  await fork.agent('one more for the deceived');
  assert.ok(fork.store.log.length > main.store.log.length);
  await assert.rejects(followerOf(fork, asking, withNoteOf(main)).directory(), (err) => err.code === 'log_invalid' && notTheSame.test(err.message));
  await main.agent('later');
  await main.agent('and later');
  assert.equal(await main.witnessNow(), 1);
  assert.equal(await fork.witnessNow(), 0);
  assert.equal(witness.latest(key.did).root.equals(main.store.logHead().root), true);

  // A reader with no witnesses takes either: nothing tells it there are two.
  assert.equal(await refusal(followerOf(fork).directory()), 'taken');
  assert.equal(await refusal(followerOf(main).directory()), 'taken');
  // One that asks for the witness takes the one it cosigned. All the other can show cosigned is the
  // checkpoint from before the two parted, which both begin with: it passes for as long as a
  // cosignature counts, and no longer. That is how long a hub can keep a reader on a second list.
  assert.equal(await refusal(followerOf(main, asking).directory()), 'taken');
  assert.equal(parseCheckpoint((await noteOf(fork)).text).size, shared);
  const deceived = followerOf(fork, asking);
  assert.equal(await refusal(deceived.directory()), 'taken');
  assert.deepEqual([deceived.witnessedSize, deceived.size], [shared, fork.store.log.length]);
  const later = { now: () => Date.now() + 6 * 60_000 };
  assert.equal(await refusal(followerOf(fork, { ...asking, ...later }).directory()), 'log_unwitnessed');
  assert.equal(await refusal(followerOf(main, { ...asking, ...later, witnessMaxAgeMs: HOUR }).directory()), 'taken');
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const impatient = new AgentClient({ hubUrl: fork.url, identity: generateIdentity(), ...asking, witnessMaxAgeMs: 1000 });
  await assert.rejects(impatient.getAgent(victim.did), (err) => err instanceof LogError && err.code === 'log_unwitnessed');
  // The first list is cosigned again every round, so its readers are not left waiting.
  assert.equal(await main.witnessNow(), 1);
  const patient = new AgentClient({ hubUrl: main.url, identity: generateIdentity(), ...asking, witnessMaxAgeMs: 1000 });
  assert.equal(await patient.getAgent(victim.did), null, 'and on the first list there is no such agent');

  // Or with more cosigned than the second list has to give.
  assert.ok(main.store.log.length > fork.store.log.length);
  await assert.rejects(followerOf(fork, asking, withNoteOf(main)).directory(), /: the hub shows more of its log cosigned than it gives to read$/);
  // A reader that has seen more of the log cosigned is not then shown less.
  const withOldNote = (path) => (path === '/v1/log/note' ? new Response(oldNote) : null);
  let shownOld = false;
  const seenMore = followerOf(main, asking, (path) => (shownOld ? withOldNote(path) : null));
  await seenMore.directory();
  assert.equal(seenMore.witnessedSize, main.store.log.length);
  shownOld = true;
  await assert.rejects(seenMore.directory({ fresh: true }), /showed \d+ entries of its log cosigned and now shows \d+/);

  // A checkpoint somebody else signed under the name of the hub, or cosigned by somebody the reader does not know.
  const mallory = generateIdentity();
  const forged = (() => {
    const text = checkpointText({ origin: fork.did, size: fork.store.log.length, root: fork.store.logHead().root });
    const theirs = { name: 'witness.example/friendly', ...generateKeyPairSync('ed25519') };
    const lines = [signNoteText(text, { name: fork.did, privateKey: mallory.privateKey, key: publicKeyBytesFromDid(fork.did) }), cosign(text, { ...theirs, key: publicKeyBytes(theirs.publicKey) })];
    return formatNote(text, lines);
  })();
  assert.equal(await refusal(followerOf(fork, asking, (path) => (path === '/v1/log/note' ? new Response(forged) : null)).directory()), 'log_invalid');
  assert.equal(await refusal(followerOf(fork, asking, (path) => (path === '/v1/log/note' ? new Response('not a note') : null)).directory()), 'log_invalid');
});

test('what a client takes as cosigned is a checkpoint of the log of its hub, signed by the hub', async (t) => {
  // The hub keeps a second log under another name, with its own key, and has the same witness watch
  // both. Each only grows, so the witness cosigns each: that it cosigned one says nothing of the other.
  const key = generateIdentity();
  const signer = { privateKey: key.privateKey, key: publicKeyBytesFromDid(key.did) };
  const second = { name: 'hub.example/second-list', type: NOTE_ED25519, key: signer.key };
  const { witness, ask } = await startWitness(t, { logs: [key.did, formatVerifier(second)] });
  const asking = { witnesses: [witness.verifier] };
  const hub = await startHub(t, watched(key, witness));
  await hub.agent('alice');
  assert.equal(await hub.witnessNow(), 1);
  assert.equal(await refusal(followerOf(hub, asking).directory()), 'taken');

  // Its checkpoint, under the other name: the list this reader is shown, said to be that other log.
  const head = hub.store.logHead();
  const text = checkpointText({ origin: second.name, size: head.size, root: head.root });
  const asSecond = signNoteText(text, { ...signer, name: second.name });
  const asItself = signNoteText(text, { ...signer, name: key.did });
  const got = await ask(formatAddCheckpoint({ old: 0, proof: [], note: formatNote(text, [asSecond]) }));
  assert.equal(got.status, 200, 'the witness cosigns it: it is a log it watches, and it only grew');
  const cosignatures = parseSignatures(got.body);
  const shown = (note) => followerOf(hub, asking, (path) => (path === '/v1/log/note' ? new Response(note) : null)).directory();
  await assert.rejects(shown(formatNote(text, [asItself, asSecond, ...cosignatures])), (err) => err.code === 'log_invalid' && /not one of its own log/.test(err.message));

  // And a checkpoint of its own log that carries a cosignature and not its signature: nobody answers for it.
  const { text: own, signatures } = await noteOf(hub);
  const withoutTheHub = signatures.filter(({ name }) => name !== key.did);
  assert.equal(withoutTheHub.length, 1);
  await assert.rejects(shown(formatNote(own, withoutTheHub)), (err) => err.code === 'log_invalid' && /not one of its own log/.test(err.message));
  assert.equal(await refusal(shown(formatNote(own, signatures))), 'taken');
});

test('a hub that went back is not cosigned, and one with no witnesses still says what its log is', async (t) => {
  const key = generateIdentity();
  const { witness } = await startWitness(t, { logs: [key.did] });
  const asking = { witnesses: [witness.verifier] };
  const first = await startHub(t, watched(key, witness));
  await first.agent('one');
  await first.agent('two');
  assert.equal(await first.witnessNow(), 1);
  await first.close();

  // The same hub with less than it had: started over, or from an old copy. The witness remembers more.
  const lines = [];
  const back = await startHub(t, { ...watched(key, witness), quiet: false, log: (line) => lines.push(line) });
  await back.agent('one again');
  assert.equal(await back.witnessNow(), 0);
  assert.equal(lines.filter((line) => /did not cosign: "it has cosigned \d+ entries of this log, more than the log has now: a log that went back is not cosigned"/.test(line)).length, 1, 'said once, to whoever runs the hub');
  assert.equal(await back.witnessNow(), 0);
  assert.equal(lines.filter((line) => /did not cosign/.test(line)).length, 1, 'and not again every round');
  assert.equal(await noteOf(back), 'not_witnessed');
  assert.equal(await refusal(followerOf(back, asking).directory()), 'log_unwitnessed');
  assert.equal(witness.latest(key.did).size, first.store.log.length);

  // No witnesses: the checkpoint is the hub's word alone, in the same form, for whoever wants to watch it.
  const alone = await startHub(t);
  await alone.agent('solo');
  assert.equal(await alone.witnessNow(), 0);
  const { text, signatures } = await noteOf(alone);
  assert.deepEqual(checkSignatures(text, signatures, { log: logVerifier(alone.did) }), { byLog: true, cosigned: [] });
  assert.equal(parseCheckpoint(text).size, alone.store.log.length);
  assert.equal(await refusal(followerOf(alone, asking).directory()), 'log_unwitnessed');
  assert.equal(await refusal(followerOf(alone).directory()), 'taken');
  // A hub that keeps no log at all has nothing for a witness to have cosigned.
  assert.equal(await refusal(followerOf(alone, asking, (path) => (path.startsWith('/v1/log/') ? new Response('{}', { status: 404 }) : null)).directory()), 'log_unwitnessed');

  // A hub told of a witness with a key that is not the one it cosigns with gets nothing it can show.
  const confusedKey = generateIdentity();
  const [real, other] = [(await startWitness(t, { logs: [confusedKey.did] })).witness, (await startWitness(t, { logs: [confusedKey.did] })).witness];
  const confused = await startHub(t, { identity: confusedKey, witnesses: [`${other.verifier}@${real.url}`], witnessIntervalMs: HOUR });
  assert.equal(await confused.witnessNow(), 0);
  assert.equal(real.latest(confusedKey.did).size, confused.store.log.length, 'the one that was asked did cosign: with a key the hub was not told of');
  assert.equal(await noteOf(confused), 'not_witnessed');

  // What a hub and a client are told of witnesses has to make sense.
  const bad = (witnesses) => () => createHub({ port: 0, quiet: true, witnesses });
  for (const witnesses of [['nonsense'], [witness.verifier], [`${witness.verifier}@ftp://x`], [`${formatVerifier(logVerifier(key.did))}@${witness.url}`], [`${witness.verifier}@${witness.url}`, `${witness.verifier}@${witness.url}`]]) {
    assert.throws(bad(witnesses), /witness/, JSON.stringify(witnesses));
  }
  const client = (options) => () => new AgentClient({ hubUrl: alone.url, identity: generateIdentity(), ...options });
  assert.throws(client({ witnesses: [witness.verifier], witnessQuorum: 2 }), TypeError);
  assert.throws(client({ witnesses: [witness.verifier], witnessQuorum: 0 }), TypeError);
  assert.throws(client({ witnesses: [witness.verifier, witness.verifier] }), TypeError);
  assert.throws(client({ witnesses: [formatVerifier(logVerifier(key.did))] }), TypeError);
  assert.throws(client({ witnesses: ['nonsense'] }), TypeError);
  assert.throws(client({ witnesses: [witness.verifier], followLog: false }), TypeError);
});
