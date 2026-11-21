import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHub } from '../src/hub/server.mjs';
import { AgentClient, createDelegation, fileStateStore, generateIdentity, memoryStateStore } from '../src/sdk/index.mjs';
import { signEvent } from '../src/core/sign.mjs';
import { readCredential } from '../src/mls/credential.mjs';
import { dmAad, dmGroupId, dmPairKey, parseDmGroupId } from '../src/mls/dm.mjs';
import { EPOCHS_RETAINED, MLS_SUITE, adoptUpdate, applyCommit, changeMembers, createGroup, createUpdate, decryptMessage, encryptMessage, epochsRetainedFor, generateKeyPackage, groupEpoch, groupMembers, inspectKeyPackage, inspectMessage, joinGroup, lapsedMembers, welcomeRecipients } from '../src/mls/member.mjs';
import { topicGroupId } from '../src/mls/topic.mjs';
import { errorText, instanceOf, rejects, signedFetch, startHub } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../bin/agenthub.mjs', import.meta.url));
const MLS = { mls: true };
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const bytes = (text) => new Uint8Array(Buffer.from(text, 'base64url'));
const texts = (result) => result.messages.map((message) => message.data.text);
const note = (text) => ({ type: 'note', data: { text } });

/** Waits until `condition()` holds, and fails the test if it never does. */
async function until(condition, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A store that can be photographed: what a thief would walk away with at that moment. */
function observableStore() {
  const store = memoryStateStore();
  return { ...store, snapshot: () => new Map(store.keys().map((key) => [key, Buffer.from(store.get(key))])) };
}

// --------------------------------------------------------------------- the adapter

test('MLS credentials: a member is an agent key or a certified instance, and its key must be the one named', async () => {
  const alice = generateIdentity();
  const mallory = generateIdentity();
  const laptop = instanceOf(alice, { name: 'laptop' });

  const own = await generateKeyPackage(alice);
  assert.deepEqual(await inspectKeyPackage(own.bytes), { agent: alice.did, instance: null, reader: alice.did, ref: own.ref });
  const instance = await generateKeyPackage(laptop);
  assert.deepEqual(await inspectKeyPackage(instance.bytes), { agent: alice.did, instance: laptop.instance.did, reader: laptop.instance.did, ref: instance.ref });
  assert.deepEqual(Object.keys(own.secret), ['key_package', 'init', 'hpke'], 'the secret part never includes the published half only');
  assert.notEqual(own.ref, (await generateKeyPackage(alice)).ref, 'each KeyPackage is used once: every one is different');

  // Mallory's key under alice's name: the credential names a key, and it is not the one that signed.
  const asAlice = await generateKeyPackage({ did: alice.did, privateKey: mallory.privateKey });
  await assert.rejects(inspectKeyPackage(asAlice.bytes), /signature does not verify/);
  // Mallory's key with the laptop's real certificate.
  const withStolenCertificate = await generateKeyPackage({ did: alice.did, instance: { did: mallory.did, privateKey: mallory.privateKey }, certificate: laptop.certificate });
  await assert.rejects(inspectKeyPackage(withStolenCertificate.bytes), /not the key the instance certificate names/);
  // Mallory's key with a certificate she signed herself in alice's name.
  const hers = instanceOf(mallory);
  const selfMade = await generateKeyPackage({ did: alice.did, instance: hers.instance, certificate: hers.certificate });
  await assert.rejects(inspectKeyPackage(selfMade.bytes), /issued by a different agent/);

  // Expired, or not a KeyPackage at all.
  const old = await generateKeyPackage(alice, { now: Date.now() - 100 * 86_400_000 });
  await assert.rejects(inspectKeyPackage(old.bytes), /expired/);
  await assert.rejects(inspectKeyPackage(new Uint8Array([1, 2, 3])), /not an MLS message/);
  await assert.rejects(inspectKeyPackage(new Uint8Array([...own.bytes, 0])), /not an MLS message/, 'nothing may follow the message');
  const group = await createGroup(alice, 'g', [instance.bytes]);
  await assert.rejects(inspectKeyPackage(group.welcome), /expected an MLS key package/);

  // An instance is brought into a group while its certificate lasts: its agent answers for that key until then, and no longer.
  const day = 86_400_000;
  const brief = instanceOf(alice, { days: 1 });
  const briefly = await generateKeyPackage(brief);
  assert.equal((await inspectKeyPackage(briefly.bytes, { now: Date.now() + day - 60_000 })).reader, brief.instance.did);
  await assert.rejects(inspectKeyPackage(briefly.bytes, { now: Date.now() + day + 60_000 }), /the certificate of that instance has run out/);
  // Where it already is, it stays, and reads. The group tells which of its members those are, for whoever is about to write in it.
  const withBrief = await createGroup(alice, 'h', [instance.bytes, briefly.bytes]);
  const lapsedAt = (ms) => lapsedMembers(withBrief.state, { now: Date.now() + ms });
  assert.deepEqual([await lapsedMembers(withBrief.state), await lapsedAt(day + 60_000), await lapsedAt(31 * day)], [[], [brief.instance.did], [laptop.instance.did, brief.instance.did]]);

  // The credential on its own.
  const key = new Uint8Array(32);
  const credential = (statement) => ({ credentialType: 'basic', identity: new TextEncoder().encode(typeof statement === 'string' ? statement : JSON.stringify(statement)) });
  assert.throws(() => readCredential({ credentialType: 'x509', certificates: [] }, key), /unsupported credential/);
  assert.throws(() => readCredential(credential('{nope'), key), /not valid JSON/);
  assert.throws(() => readCredential(credential({ name: 'alice' }), key), /does not name an agent/);
  assert.throws(() => readCredential(credential({ agent: alice.did, admin: true }), key), /unexpected fields/);
  assert.throws(() => readCredential(credential({ agent: alice.did }), key), /not the key of the agent/);
  assert.throws(() => readCredential(credential({ agent: alice.did, pad: 'x'.repeat(5000) }), key), /too large/);
});

test('an MLS group: a message opens once for each member, tied to its envelope, and names who encrypted it', async () => {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const laptop = instanceOf(alice);
  const bobPackage = await generateKeyPackage(bob);
  const laptopPackage = await generateKeyPackage(laptop);

  const made = await createGroup(alice, 'agenthub/test/group', [bobPackage.bytes, laptopPackage.bytes]);
  assert.deepEqual(made.members.map((member) => member.reader), [alice.did, bob.did, laptop.instance.did]);
  assert.deepEqual(await welcomeRecipients(made.welcome), [bobPackage.ref, laptopPackage.ref]);
  assert.deepEqual(await inspectMessage(made.welcome), { wireformat: 'welcome', recipients: 2 });
  // A group can start with its maker alone: there is nobody to invite, and it is at epoch 1 like any other.
  const alone = await createGroup(alice, 'alone', []);
  assert.deepEqual([alone.welcome, alone.members.map((member) => member.reader), await groupEpoch(alone.state)], [null, [alice.did], 1]);

  const atBob = await joinGroup(bob, made.welcome, bobPackage.secret);
  const atLaptop = await joinGroup(laptop, made.welcome, laptopPackage.secret);
  assert.equal(atBob.groupId, 'agenthub/test/group');
  assert.deepEqual(atBob.members, made.members, 'everyone sees the same members');
  // An invitation opens only with the secret of the KeyPackage it was sealed to.
  await assert.rejects(joinGroup(bob, made.welcome, (await generateKeyPackage(bob)).secret));

  const aad = dmAad(alice.did, bob.did, 'event-1');
  const sent = await encryptMessage(made.state, new TextEncoder().encode('hola'), aad);
  assert.deepEqual(await inspectMessage(sent.message), { wireformat: 'private_message', groupId: 'agenthub/test/group', epoch: 1, contentType: 'application' });
  assert.ok(!Buffer.from(sent.message).includes(Buffer.from('hola')), 'what travels is ciphertext');

  const read = await decryptMessage(atBob.state, sent.message, aad);
  assert.equal(new TextDecoder().decode(read.plaintext), 'hola');
  assert.deepEqual(read.sender, { agent: alice.did, instance: null, reader: alice.did });
  // Every member opens it, each with its own state.
  assert.equal(new TextDecoder().decode((await decryptMessage(atLaptop.state, sent.message, aad)).plaintext), 'hola');

  // Not twice: the state that read it has let go of the key. Not for another envelope. Not if altered.
  await assert.rejects(decryptMessage(read.state, sent.message, aad), /Desired gen in the past/);
  await assert.rejects(decryptMessage(atBob.state, sent.message, dmAad(bob.did, alice.did, 'event-1')), /not made for this envelope/);
  const altered = Uint8Array.from(sent.message);
  altered[altered.length - 1] ^= 1;
  await assert.rejects(decryptMessage(atBob.state, altered, aad));
  // Not by the sender's own later state either, and not in another group.
  await assert.rejects(decryptMessage(sent.state, sent.message, aad));
  const elsewhere = await createGroup(alice, 'another/group', [(await generateKeyPackage(bob)).bytes]);
  await assert.rejects(decryptMessage(elsewhere.state, sent.message, aad), /different group/);

  // From an instance, the sender is the instance, with the agent it stands for.
  const reply = await encryptMessage(atLaptop.state, new TextEncoder().encode('desde el portátil'), aad);
  assert.deepEqual((await decryptMessage(read.state, reply.message, aad)).sender, { agent: alice.did, instance: laptop.instance.did, reader: laptop.instance.did });
});

/**
 * A commit made with ts-mls directly, carrying whatever proposals are asked for: what a member
 * running other software could send. `proposals(mls)` returns them.
 */
async function foreignCommit(stateBytes, proposals) {
  const mls = await import('ts-mls');
  const impl = await mls.getCiphersuiteImpl(mls.getCiphersuiteFromName(MLS_SUITE));
  const clientConfig = { keyRetentionConfig: mls.defaultKeyRetentionConfig, lifetimeConfig: mls.defaultLifetimeConfig, keyPackageEqualityConfig: mls.defaultKeyPackageEqualityConfig, paddingConfig: mls.defaultPaddingConfig, authService: { validateCredential: async () => true } };
  const state = { ...mls.decodeGroupState(stateBytes, 0)[0], clientConfig };
  const { commit } = await mls.createCommit({ state, cipherSuite: impl }, { extraProposals: proposals(mls) });
  return mls.encodeMlsMessage(commit);
}

test('a commit renews a member\'s keys: the others follow, a copy of its old state cannot, and nothing but a renewal is accepted', async () => {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const laptop = instanceOf(alice);
  const bobPackage = await generateKeyPackage(bob);
  const laptopPackage = await generateKeyPackage(laptop);
  const made = await createGroup(alice, 'agenthub/test/renewal', [bobPackage.bytes, laptopPackage.bytes]);
  const atBob = await joinGroup(bob, made.welcome, bobPackage.secret);
  const atLaptop = await joinGroup(laptop, made.welcome, laptopPackage.secret);
  assert.deepEqual(await Promise.all([made.state, atBob.state, atLaptop.state].map(groupEpoch)), [1, 1, 1], 'a group is born at epoch 1');
  const aad = (id) => dmAad(alice.did, bob.did, id);
  const seal = (state, text, id) => encryptMessage(state, new TextEncoder().encode(text), aad(id));
  const open = async (state, message, id) => new TextDecoder().decode((await decryptMessage(state, message, aad(id))).plaintext);

  // Somebody copies bob's state. While nothing changes, the copy reads what bob reads.
  const copy = atBob.state;
  const first = await seal(made.state, 'uno', 'e1');
  assert.equal(await open(copy, first.message, 'e1'), 'uno');
  // No operation alters the state it is given: what it leads to is in what it returns. A member
  // whose commit is turned away, or whose message is never sent, is still where it was.
  const untouched = Buffer.from(atBob.state);
  await decryptMessage(atBob.state, first.message, aad('e1'));
  await seal(atBob.state, 'no enviado', 'e0');
  await createUpdate(atBob.state);
  await applyCommit(atBob.state, (await createUpdate(made.state)).commit);
  assert.deepEqual(Buffer.from(atBob.state), untouched);

  // Bob renews his keys. Whoever relays the commit learns its kind, its group and its epoch, and no more.
  const renewal = await createUpdate(atBob.state);
  assert.deepEqual(await inspectMessage(renewal.commit), { wireformat: 'private_message', groupId: 'agenthub/test/renewal', epoch: 1, contentType: 'commit' });
  assert.equal(await groupEpoch(renewal.state), 2);
  const aliceNext = await applyCommit(first.state, renewal.commit);
  assert.deepEqual([aliceNext.epoch, aliceNext.sender], [2, { agent: bob.did, instance: null, reader: bob.did }]);
  const laptopNext = await applyCommit(atLaptop.state, renewal.commit);

  // From the new epoch on the members read each other, and the copy reads nothing. It cannot apply
  // the commit either: the new secrets are sealed to everybody's keys except the ones bob had.
  const second = await seal(aliceNext.state, 'dos', 'e2');
  assert.equal((await inspectMessage(second.message)).epoch, 2);
  assert.equal(await open(renewal.state, second.message, 'e2'), 'dos');
  assert.equal(await open(laptopNext.state, second.message, 'e2'), 'dos');
  await assert.rejects(open(copy, second.message, 'e2'), /epoch this member has not reached/);
  await assert.rejects(applyCommit(copy, renewal.commit));

  // The other half of that fact: only bob could shut out a copy of bob's state. A renewal by
  // somebody else is sealed to the keys the copy holds, and the copy follows it.
  const copyOfLaptop = laptopNext.state;
  const byAlice = await createUpdate(second.state);
  const followed = await applyCommit(copyOfLaptop, byAlice.commit);
  assert.equal(await open(followed.state, (await seal(byAlice.state, 'tres', 'e3')).message, 'e3'), 'tres');

  // A message that was on its way when the keys were renewed is still opened - once - and still names its sender.
  const late = await decryptMessage(renewal.state, first.message, aad('e1'));
  assert.equal(new TextDecoder().decode(late.plaintext), 'uno');
  assert.deepEqual(late.sender, { agent: alice.did, instance: null, reader: alice.did });
  await assert.rejects(decryptMessage(late.state, first.message, aad('e1')));

  // Bob makes another commit and, before he knows whether it was the one accepted, reads a message
  // of the epoch he is still in. The state he then moves to must not bring that key back.
  const pending = await createUpdate(late.state);
  const fourth = await seal(second.state, 'cuatro', 'e4');
  const read = await decryptMessage(late.state, fourth.message, aad('e4'));
  assert.equal(await open(pending.state, fourth.message, 'e4'), 'cuatro', 'the state made with the commit still holds it');
  const adopted = await adoptUpdate(read.state, pending.state);
  assert.equal(await groupEpoch(adopted), 3);
  await assert.rejects(decryptMessage(adopted, fourth.message, aad('e4')));
  await assert.rejects(decryptMessage(adopted, first.message, aad('e1')), 'nor one used up in an epoch further back');
  const aliceThird = await applyCommit(fourth.state, pending.commit);
  assert.equal(await open(adopted, (await seal(aliceThird.state, 'cinco', 'e5')).message, 'e5'), 'cinco');
  await assert.rejects(adoptUpdate(made.state, pending.state), /does not follow/);
  await assert.rejects(adoptUpdate(pending.state, pending.state), /does not follow/);

  // What is not accepted as a commit.
  await assert.rejects(applyCommit(aliceNext.state, renewal.commit), /commit is for epoch 1, this member is at 2/);
  await assert.rejects(applyCommit(atLaptop.state, first.message), /not a commit/);
  await assert.rejects(applyCommit(atLaptop.state, made.welcome), /expected an MLS private message/);
  await assert.rejects(applyCommit(atLaptop.state, new Uint8Array(40)), /not an MLS message/);
  const altered = Uint8Array.from(renewal.commit);
  altered[altered.length - 1] ^= 1;
  await assert.rejects(applyCommit(atLaptop.state, altered));
  const elsewhere = await createGroup(alice, 'another/group', [(await generateKeyPackage(bob)).bytes]);
  await assert.rejects(applyCommit(atLaptop.state, (await createUpdate(elsewhere.state)).commit), /different group/);
  // A commit decides who is in a group as well as its keys. Here that is not how members change:
  // one that brings somebody in, or leaves somebody out, is refused by every member that sees it.
  const stranger = await generateKeyPackage(generateIdentity());
  const adding = await foreignCommit(atBob.state, (mls) => [{ proposalType: 'add', add: { keyPackage: mls.decodeMlsMessage(stranger.bytes, 0)[0].keyPackage } }]);
  await assert.rejects(applyCommit(made.state, adding), /changes who is in the group/);
  const removing = await foreignCommit(atBob.state, () => [{ proposalType: 'remove', remove: { removed: 2 } }]);
  await assert.rejects(applyCommit(made.state, removing), /changes who is in the group/);
  await assert.rejects(applyCommit(atLaptop.state, removing));
});

test('a commit brings members in and leaves them out, when those who apply it agree', async () => {
  const owner = generateIdentity();
  const alice = generateIdentity();
  const bob = generateIdentity();
  const carol = generateIdentity();
  const laptop = instanceOf(alice);
  const packages = {};
  for (const [name, identity] of Object.entries({ alice, bob, carol, laptop })) packages[name] = await generateKeyPackage(identity);
  const aad = new TextEncoder().encode('aad');
  const seal = (state, text) => encryptMessage(state, new TextEncoder().encode(text), aad);
  const open = async (state, message) => new TextDecoder().decode((await decryptMessage(state, message, aad)).plaintext);
  const member = (identity) => ({ agent: identity.did, instance: identity.instance?.did ?? null, reader: identity.instance?.did ?? identity.did });
  // The rule of a topic: its owner decides who is in. An agent may also bring in and leave out its own instances.
  const rule = ({ sender, added, removed }) => sender.agent === owner.did || [...added, ...removed].every((changed) => changed.agent === sender.agent);
  const ruled = { mayChange: rule };

  // The owner starts a group with alice. Whoever joins is told who made the invitation.
  const made = await createGroup(owner, 'agenthub/test/topic', [packages.alice.bytes]);
  const atAlice = await joinGroup(alice, made.welcome, packages.alice.secret);
  assert.deepEqual([atAlice.epoch, atAlice.inviter], [1, member(owner)]);
  const early = await seal(made.state, 'antes de bob');
  assert.equal(await open(atAlice.state, early.message), 'antes de bob');

  // The owner brings bob in. Alice accepts it because of who made the commit: by default nobody may.
  const adding = await changeMembers(early.state, { add: [packages.bob.bytes] });
  assert.deepEqual(adding.members, [member(owner), member(alice), member(bob)]);
  assert.deepEqual(await inspectMessage(adding.welcome), { wireformat: 'welcome', recipients: 1 });
  assert.deepEqual(await inspectMessage(adding.commit), { wireformat: 'private_message', groupId: 'agenthub/test/topic', epoch: 1, contentType: 'commit' });
  await assert.rejects(applyCommit(atAlice.state, adding.commit), /changes who is in the group in a way that is not accepted/);
  const aliceSecond = await applyCommit(atAlice.state, adding.commit, ruled);
  assert.deepEqual([aliceSecond.epoch, aliceSecond.sender, aliceSecond.added, aliceSecond.removed], [2, member(owner), [member(bob)], []]);
  assert.deepEqual(await groupMembers(aliceSecond.state), adding.members);
  // Bob joins the group as it is now: he reads from here on, and nothing from before.
  const atBob = await joinGroup(bob, adding.welcome, packages.bob.secret);
  assert.deepEqual([atBob.epoch, atBob.groupId, atBob.inviter, atBob.members], [2, 'agenthub/test/topic', member(owner), adding.members]);
  const second = await seal(adding.state, 'con bob');
  assert.equal(await open(atBob.state, second.message), 'con bob');
  assert.equal(await open(aliceSecond.state, second.message), 'con bob');
  await assert.rejects(open(atBob.state, early.message), /epoch whose keys this member does not have/);

  // Alice's agent starts an instance. Alice brings it in herself: it is hers, and its certificate says so.
  const selfService = await changeMembers(aliceSecond.state, { add: [packages.laptop.bytes] });
  const ownerThird = await applyCommit(second.state, selfService.commit, ruled);
  assert.deepEqual([ownerThird.sender, ownerThird.added], [member(alice), [member(laptop)]]);
  const bobThird = await applyCommit(atBob.state, selfService.commit, ruled);
  const atLaptop = await joinGroup(laptop, selfService.welcome, packages.laptop.secret);
  assert.deepEqual([atLaptop.epoch, atLaptop.inviter], [3, member(alice)]);

  // What alice may not do is bring in somebody who is not hers, or leave out somebody who is not.
  // Everybody refuses, and stays where they were.
  const intruding = await changeMembers(selfService.state, { add: [packages.carol.bytes] });
  await assert.rejects(applyCommit(ownerThird.state, intruding.commit, ruled), /changes who is in the group in a way that is not accepted/);
  await assert.rejects(applyCommit(bobThird.state, intruding.commit, ruled), /not accepted/);
  const expelling = await changeMembers(selfService.state, { remove: [bob.did] });
  await assert.rejects(applyCommit(ownerThird.state, expelling.commit, ruled), /not accepted/);
  // The invitation she made for carol does open - MLS knows nothing of the rule - and it says who
  // made it, which is what lets carol turn it down.
  assert.deepEqual((await joinGroup(carol, intruding.welcome, packages.carol.secret)).inviter, member(alice));

  // The owner leaves bob out. The others move on. Bob cannot, and what is sent afterwards is closed to him.
  const removing = await changeMembers(ownerThird.state, { remove: [bob.did] });
  assert.equal(removing.welcome, null);
  assert.deepEqual(removing.members, [member(owner), member(alice), member(laptop)]);
  const aliceFourth = await applyCommit(selfService.state, removing.commit, ruled);
  assert.deepEqual([aliceFourth.epoch, aliceFourth.removed, aliceFourth.added], [4, [member(bob)], []]);
  const laptopFourth = await applyCommit(atLaptop.state, removing.commit, ruled);
  const fourth = await seal(removing.state, 'sin bob');
  assert.equal(await open(aliceFourth.state, fourth.message), 'sin bob');
  assert.equal(await open(laptopFourth.state, fourth.message), 'sin bob');
  await assert.rejects(applyCommit(bobThird.state, removing.commit, ruled), (err) => err.code === 'left_out' && /this member was left out of the group/.test(err.message));
  await assert.rejects(open(bobThird.state, fourth.message), /epoch this member has not reached/);

  // Left out and brought in again in one commit, with a new KeyPackage: how a reader that lost its
  // state gets back. One reader is never in a group twice.
  const again = await generateKeyPackage(laptop);
  const readding = await changeMembers(fourth.state, { remove: [laptop.instance.did], add: [again.bytes] });
  const rejoined = await joinGroup(laptop, readding.welcome, again.secret);
  assert.deepEqual([rejoined.epoch, rejoined.members], [5, [member(owner), member(alice), member(laptop)]]);
  assert.equal(await open(rejoined.state, (await seal(readding.state, 'de vuelta')).message), 'de vuelta');
  await assert.rejects(open(laptopFourth.state, (await seal(readding.state, 'no para el estado viejo')).message));
  await assert.rejects(changeMembers(readding.state, { add: [(await generateKeyPackage(laptop)).bytes] }));

  // A commit can carry other things than members: new settings for the group, an order to start it
  // again elsewhere. None of that is used here, and it is refused whoever sends it.
  const everything = { mayChange: () => true };
  const resetting = await foreignCommit(readding.state, () => [{ proposalType: 'group_context_extensions', groupContextExtensions: { extensions: [] } }]);
  await assert.rejects(applyCommit(rejoined.state, resetting, everything), /something other than a change of keys or of members/);
  const moving = await foreignCommit(readding.state, () => [{ proposalType: 'reinit', reinit: { groupId: new Uint8Array([1]), version: 'mls10', cipherSuite: MLS_SUITE, extensions: [] } }]);
  await assert.rejects(applyCommit(rejoined.state, moving, everything), /something other than a change of keys or of members/);

  // Misuse.
  await assert.rejects(changeMembers(readding.state, { remove: [carol.did] }), /is not in the group/);
  await assert.rejects(changeMembers(readding.state, { remove: [owner.did] }), /cannot leave itself out/);
  await assert.rejects(changeMembers(readding.state, {}), /nothing to change/);
  await assert.rejects(changeMembers(readding.state, { add: [made.welcome] }), /expected an MLS key package/);
});

test('a large group keeps the keys of fewer past epochs, so that its state does not grow with both', async () => {
  assert.deepEqual([1, 2, 4, 5, 8, 16, 17, 32, 33, 100].map(epochsRetainedFor), [16, 16, 16, 12, 8, 4, 3, 2, 2, 2]);
  assert.equal(epochsRetainedFor(2), EPOCHS_RETAINED);

  // Seventeen members: three epochs back, and no more.
  const identities = Array.from({ length: 17 }, () => generateIdentity());
  const packages = await Promise.all(identities.slice(1).map((identity) => generateKeyPackage(identity)));
  const made = await createGroup(identities[0], 'agenthub/test/large', packages.map((entry) => entry.bytes));
  const aad = new Uint8Array();
  const first = await encryptMessage(made.state, new TextEncoder().encode('uno'), aad);
  let reader = (await joinGroup(identities[1], made.welcome, packages[0].secret)).state;
  let writer = first.state;
  const sizes = [reader.length];
  for (let renewal = 1; renewal <= 4; renewal++) {
    const update = await createUpdate(writer);
    writer = update.state;
    reader = (await applyCommit(reader, update.commit)).state;
    sizes.push(reader.length);
    if (renewal === 3) assert.equal(new TextDecoder().decode((await decryptMessage(reader, first.message, aad)).plaintext), 'uno');
  }
  await assert.rejects(decryptMessage(reader, first.message, aad), /epoch whose keys this member does not have/);
  assert.ok(sizes[4] - sizes[3] < (sizes[1] - sizes[0]) / 2, `the state stops growing once the limit is reached: ${sizes.join(', ')}`);
});

// ------------------------------------------------------------ conversations on the hub

test('direct messages over MLS: every reader of both agents opens them, and the hub none', async (t) => {
  const hub = await startHub(t);
  const aliceIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity, MLS);
  const bob = await hub.agent('bob', generateIdentity(), MLS);
  const laptop = hub.client(instanceOf(aliceIdentity, { name: 'laptop' }), MLS);
  await laptop.registerInstance();
  assert.equal(alice.mlsEnabled, true);

  const secret = 'la-clave-del-repositorio-privado';
  const receipt = await bob.send(alice.did, { type: 'secret', data: { text: secret } });
  assert.equal(receipt.encryption, 'mls-v1');

  // What the hub holds: who writes to whom, in which group, and bytes it cannot open.
  const stored = hub.store.pending(alice.did)[0].envelope.event;
  assert.deepEqual([stored.type, stored.encryption, Object.keys(stored.data)], ['agenthub.encrypted', 'mls-v1', ['group', 'message']]);
  assert.ok(!JSON.stringify([...hub.store.inboxes, ...hub.store.welcomes, ...hub.store.dmGroups]).includes(secret));
  assert.equal(parseDmGroupId(stored.data.group).generation, 1);
  const conversation = hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));
  assert.deepEqual([...conversation.members].sort(), [alice.did, bob.did, laptop.instanceDid].sort());

  // Both readers of alice open it, each from its own inbox and with its own state.
  for (const reader of [alice, laptop]) {
    const { messages, errors } = await reader.poll();
    assert.deepEqual(errors, []);
    assert.deepEqual(messages.map((message) => [message.type, message.data.text, message.sender, message.instance, message.encrypted, message.encryption]), [['secret', secret, bob.did, null, true, 'mls-v1']]);
  }
  assert.deepEqual(hub.store.welcomes.size, 0, 'each invitation is gone once its reader has used it');

  // An instance answers, and can now read what comes back: this is what it could not do before.
  const answer = await laptop.send(bob.did, note('recibido, desde el portátil'));
  assert.equal(answer.encryption, 'mls-v1');
  const [got] = (await bob.poll()).messages;
  assert.deepEqual([got.data.text, got.sender, got.instance, got.encryption], ['recibido, desde el portátil', alice.did, laptop.instanceDid, 'mls-v1']);

  // A run of messages both ways, read in order, in the same group.
  for (let i = 1; i <= 4; i++) {
    await bob.send(alice.did, note(`b${i}`));
    await alice.send(bob.did, note(`a${i}`));
  }
  assert.deepEqual(texts(await alice.poll()), ['b1', 'b2', 'b3', 'b4']);
  assert.deepEqual(texts(await laptop.poll()), ['b1', 'b2', 'b3', 'b4']);
  assert.deepEqual(texts(await bob.poll()), ['a1', 'a2', 'a3', 'a4']);
  assert.equal(hub.store.dmGroups.get(dmPairKey(alice.did, bob.did)).generation, 1, 'one group all along');

  // Over a stream it is the same.
  const arrived = [];
  const listener = bob.listen((message) => void arrived.push(message.data.text));
  await listener.ready;
  await alice.send(bob.did, note('en directo'));
  for (let waited = 0; arrived.length === 0 && waited < 3000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(arrived, ['en directo']);
});

test('forward secrecy: the key that opened a message is gone, and so is the secret that opened the invitation', async (t) => {
  const hub = await startHub(t);
  const store = observableStore();
  const alice = await hub.agent('alice', generateIdentity(), MLS);
  const bob = await hub.agent('bob', generateIdentity(), { state: store });
  const published = store.keys('kp/').length;
  assert.equal(published, 10, 'bob keeps the secret of every KeyPackage he published');

  await alice.send(bob.did, note('uno'));
  const invitation = hub.store.welcomes.get(bob.did)[0];
  assert.deepEqual(texts(await bob.poll()), ['uno']);
  // The invitation was sealed to one of those KeyPackages. Its secret is deleted on use: kept, it
  // would open the invitation again for anyone who took it later, and with it the whole conversation.
  const [sealedTo] = await welcomeRecipients(bytes(invitation.welcome));
  assert.equal(store.get(`kp/${sealedTo}`), null);
  assert.equal(store.keys('kp/').length, published - 1);

  // Somebody records the next message on its way, then steals bob's state.
  await alice.send(bob.did, note('dos'));
  const recorded = hub.store.pending(bob.did)[0].envelope.event;
  const group = `group/${recorded.data.group}`;
  const aad = dmAad(alice.did, bob.did, recorded.id);
  const before = store.snapshot();
  assert.deepEqual(texts(await bob.poll()), ['dos']);
  const after = store.snapshot();

  // Stolen after bob read it: the recorded message stays closed.
  await assert.rejects(decryptMessage(after.get(group), bytes(recorded.data.message), aad), /Desired gen in the past/);
  // Stolen before he read it, it opens. That is the other half of the same fact: what protects
  // the past is that the state moved on, so a copy of an older state is as good as the key.
  assert.equal(new TextDecoder().decode((await decryptMessage(before.get(group), bytes(recorded.data.message), aad)).plaintext), JSON.stringify(note('dos')));
  assert.notDeepEqual(before.get(group), after.get(group));

  // The same on the sending side: alice's state after sending cannot open what she sent.
  const hers = observableStore();
  const carol = await hub.agent('carol', generateIdentity(), { state: hers });
  await carol.send(bob.did, note('tres'));
  const sent = hub.store.pending(bob.did)[0].envelope.event;
  await assert.rejects(decryptMessage(hers.snapshot().get(`group/${sent.data.group}`), bytes(sent.data.message), dmAad(carol.did, bob.did, sent.id)));
});

test('when the readers change a new group is made: a new instance gets in, a removed one is left out', async (t) => {
  const hub = await startHub(t);
  const aliceIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity, MLS);
  const bob = await hub.agent('bob', generateIdentity(), MLS);
  const conversation = () => hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));

  await bob.send(alice.did, note('antes'));
  assert.deepEqual([conversation().generation, conversation().members.length], [1, 2]);
  const first = conversation().group;

  // Alice starts an instance. The next message, whoever sends it, goes to a group that holds it.
  const laptop = hub.client(instanceOf(aliceIdentity), MLS);
  await laptop.registerInstance();
  await bob.send(alice.did, note('con el portátil'));
  assert.deepEqual([conversation().generation, conversation().members.length, conversation().previous], [2, 3, first]);
  assert.deepEqual(texts(await laptop.poll()), ['con el portátil'], 'it reads from the moment it is in, and nothing earlier');
  assert.deepEqual(texts(await alice.poll()), ['antes', 'con el portátil'], 'alice still opens the message of the group before');
  // The new instance can be the one that makes the next group, too.
  const tablet = hub.client(instanceOf(aliceIdentity), MLS);
  await tablet.registerInstance();
  await tablet.send(bob.did, note('desde la tableta'));
  assert.deepEqual([conversation().generation, conversation().members.length], [3, 4]);
  assert.deepEqual(texts(await bob.poll()), ['desde la tableta']);

  // The laptop is lost. Once removed, the next group does not hold it, and it gets nothing more.
  await alice.removeInstance(laptop.instanceDid);
  await bob.send(alice.did, note('sin el portátil'));
  assert.deepEqual([conversation().generation, conversation().members.length], [4, 3]);
  assert.ok(!conversation().members.includes(laptop.instanceDid));
  assert.deepEqual(texts(await alice.poll()), ['sin el portátil']);
  assert.deepEqual(texts(await tablet.poll()), ['sin el portátil']);
  await rejects(laptop.poll(), 403, 'instance_removed');
  assert.equal(hub.store.keyPackages.has(laptop.instanceDid), false, 'nobody can add it to a group again');

  // The hub accepts the group before the current one, for what was already on its way, and nothing older.
  const envelope = (group) => signEvent({ specversion: '1.0', id: `late-${group.length}`, source: alice.did, type: 'agenthub.encrypted', time: new Date().toISOString(), recipient: bob.did, encryption: 'mls-v1', data: { group, message: hub.store.pending(alice.did).at(-1)?.envelope.event.data.message ?? b64([0]) } }, aliceIdentity);
  const late = await signedFetch(hub, aliceIdentity, 'POST', '/v1/messages', envelope(first));
  assert.equal(`${late.status} ${late.code}`, '409 stale_group');
  assert.deepEqual([late.json.error.generation, late.json.error.group], [4, conversation().group]);
});

test('two readers making the same conversation at once end up in one group', async (t) => {
  const hub = await startHub(t);
  const alice = await hub.agent('alice', generateIdentity(), MLS);
  const bob = await hub.agent('bob', generateIdentity(), MLS);

  const receipts = await Promise.all([alice.send(bob.did, note('de alice')), bob.send(alice.did, note('de bob'))]);
  assert.deepEqual(receipts.map((receipt) => receipt.encryption), ['mls-v1', 'mls-v1']);
  assert.equal(hub.store.dmGroups.get(dmPairKey(alice.did, bob.did)).generation, 1, 'one of them won; the other joined its group');
  assert.deepEqual(texts(await alice.poll()), ['de bob']);
  assert.deepEqual(texts(await bob.poll()), ['de alice']);

  // And many at once, from one client: its state advances one message at a time.
  await Promise.all([1, 2, 3, 4, 5].map((n) => alice.send(bob.did, note(`m${n}`))));
  const burst = await bob.poll();
  assert.deepEqual(burst.errors, []);
  assert.deepEqual(texts(burst).sort(), ['m1', 'm2', 'm3', 'm4', 'm5']);
});

// ------------------------------------------------------------------- renewing keys

test('renewing keys: the conversation goes on in the same group, and a copy of the old state stops reading', async (t) => {
  const hub = await startHub(t);
  const store = observableStore();
  const alice = await hub.agent('alice', generateIdentity(), MLS);
  const bob = await hub.agent('bob', generateIdentity(), { state: store });
  const conversation = () => hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));
  const epoch = () => hub.store.mlsLog(conversation().group).epoch;
  const lastTo = (client) => hub.store.pending(client.did).at(-1).envelope.event;
  const aad = (event) => dmAad(alice.did, bob.did, event.id);

  await alice.send(bob.did, note('uno'));
  assert.deepEqual(texts(await bob.poll()), ['uno']);
  const { group } = conversation();
  assert.equal(epoch(), 1);

  // Somebody walks away with a copy of bob's state. A message is already on its way to him.
  const copy = store.snapshot().get(`group/${group}`);
  await alice.send(bob.did, note('en camino'));
  const onItsWay = lastTo(bob);

  // Bob renews his keys, and still opens what was sent before he did.
  assert.deepEqual(await bob.renewConversationKeys(alice.did), { group, epoch: 2 });
  assert.deepEqual([epoch(), conversation().generation], [2, 1], 'the same group, with new keys');
  assert.deepEqual(texts(await bob.poll()), ['en camino']);

  // Alice finds out on her own the next time she writes: what she sends is of the new epoch.
  assert.equal((await alice.send(bob.did, note('después'))).encryption, 'mls-v1');
  const after = lastTo(bob);
  assert.equal((await inspectMessage(bytes(after.data.message))).epoch, 2);
  assert.deepEqual(texts(await bob.poll()), ['después']);
  await bob.send(alice.did, note('recibido'));
  assert.deepEqual(texts(await alice.poll()), ['recibido']);

  // The copy opens what was sent before the renewal, and nothing sent after it. The commit is in
  // the hub's log for any reader that asks, and it is of no use to the copy: it cannot apply it.
  assert.equal(new TextDecoder().decode((await decryptMessage(copy, bytes(onItsWay.data.message), aad(onItsWay))).plaintext), JSON.stringify(note('en camino')));
  await assert.rejects(decryptMessage(copy, bytes(after.data.message), aad(after)), /epoch this member has not reached/);
  const log = hub.store.mlsLog(group);
  assert.deepEqual(log.commits.map((entry) => entry.epoch), [1]);
  await assert.rejects(applyCommit(copy, bytes(log.commits[0].message)));

  // With an agent that does not use MLS there is nothing to renew, and without MLS state nothing at all.
  const carol = await hub.agent('carol');
  assert.equal(await alice.renewConversationKeys(carol.did), null);
  await assert.rejects(carol.renewConversationKeys(alice.did), /keeps no MLS state/);
});

test('one commit ends each epoch: readers that renew at once all get their turn, in the same order for everybody', async (t) => {
  const hub = await startHub(t);
  const aliceIdentity = generateIdentity();
  const aliceStore = memoryStateStore();
  const alice = await hub.agent('alice', aliceIdentity, { state: aliceStore });
  const bob = await hub.agent('bob', generateIdentity(), MLS);
  const laptop = hub.client(instanceOf(aliceIdentity), MLS);
  await laptop.registerInstance();
  await alice.send(bob.did, note('hola'));
  assert.deepEqual(texts(await bob.poll()), ['hola']);
  const conversation = () => hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));
  const { group } = conversation();

  const renewed = await Promise.all([alice.renewConversationKeys(bob.did), bob.renewConversationKeys(alice.did), laptop.renewConversationKeys(bob.did)]);
  assert.deepEqual(renewed.map((result) => result.epoch).sort(), [2, 3, 4], 'each renewal ended a different epoch');
  assert.deepEqual([hub.store.mlsLog(group).epoch, conversation().generation, conversation().group], [4, 1, group]);

  // Everybody ended up in the same place: each one writes, and the others read it.
  await alice.send(bob.did, note('de alice'));
  await laptop.send(bob.did, note('del portátil'));
  await bob.send(alice.did, note('de bob'));
  const atBob = await bob.poll();
  assert.deepEqual([texts(atBob), atBob.errors], [['de alice', 'del portátil'], []]);
  assert.deepEqual(texts(await alice.poll()), ['de bob']);
  assert.deepEqual(texts(await laptop.poll()), ['de bob']);
  assert.equal(conversation().generation, 1);

  // A renewal lands between alice encrypting a message and the hub receiving it. The message is of
  // the epoch before: the hub turns it away, and she encrypts it again with the new keys.
  const attempts = [];
  const overtaken = async (url, init) => {
    if (init.method === 'POST' && new URL(url).pathname === '/v1/messages') {
      if (attempts.length === 0) await bob.renewConversationKeys(alice.did);
      attempts.push((await inspectMessage(bytes(JSON.parse(init.body).event.data.message))).epoch);
    }
    return fetch(url, init);
  };
  const receipt = await hub.client(aliceIdentity, { state: aliceStore, fetch: overtaken }).send(bob.did, note('a la segunda'));
  assert.equal(receipt.encryption, 'mls-v1');
  assert.deepEqual(attempts, [4, 5], 'the application sent it once');
  assert.deepEqual(texts(await bob.poll()), ['a la segunda']);
});

test('a reader that was away follows the renewals it missed, in order, and no further than what it is reading', async (t) => {
  const hub = await startHub(t);
  const store = observableStore();
  const alice = await hub.agent('alice', generateIdentity(), MLS);
  const bob = await hub.agent('bob', generateIdentity(), { state: store });
  await alice.send(bob.did, note('m1'));
  const { group } = hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));
  const bobEpoch = () => groupEpoch(store.get(`group/${group}`));
  const renew = async (times) => {
    for (let i = 0; i < times; i++) await alice.renewConversationKeys(bob.did);
  };
  await renew(1);
  await alice.send(bob.did, note('m2'));
  await renew(2);
  await alice.send(bob.did, note('m3'));
  assert.equal(hub.store.mlsLog(group).epoch, 4);

  // Bob comes back. With each message he goes as far as that message and stops: the ones before
  // it in his inbox were encrypted with the keys he has.
  assert.deepEqual(texts(await bob.poll({ limit: 1 })), ['m1']);
  assert.equal(await bobEpoch(), 1);
  assert.deepEqual(texts(await bob.poll({ limit: 1 })), ['m2']);
  assert.equal(await bobEpoch(), 2);
  assert.deepEqual(texts(await bob.poll()), ['m3']);
  assert.equal(await bobEpoch(), 4);

  // To write he must be in the newest epoch, so he goes there at once. What he had not read yet he
  // still reads afterwards: the keys of the epochs he left are kept for a while.
  await alice.send(bob.did, note('m4'));
  await renew(EPOCHS_RETAINED);
  await bob.send(alice.did, note('respuesta'));
  assert.equal(await bobEpoch(), 4 + EPOCHS_RETAINED);
  assert.deepEqual(texts(await bob.poll()), ['m4']);
  assert.deepEqual(texts(await alice.poll()), ['respuesta']);

  // For a while, and no more: a message left unread across more renewals than that is lost.
  await alice.send(bob.did, note('m5'));
  await renew(EPOCHS_RETAINED + 1);
  await bob.send(alice.did, note('sigo aquí'));
  const late = await bob.poll();
  assert.deepEqual(late.messages, []);
  assert.deepEqual(late.errors.map(errorText), ['cannot decrypt (message is of an epoch whose keys this member does not have)']);
  assert.deepEqual(texts(await alice.poll()), ['sigo aquí'], 'the conversation itself is unharmed');
});

test('keys are renewed without anybody asking: after so many messages sent or read, or so long', async (t) => {
  const hub = await startHub(t);
  const store = observableStore();
  const tries = [];
  const counting = (url, init) => {
    if (init.method === 'POST' && new URL(url).pathname.endsWith('/commits')) tries.push(hub.store.pending(bob.did).length);
    return fetch(url, init);
  };
  const alice = await hub.agent('alice', generateIdentity(), { mls: true, renewKeysAfter: { messages: 3 } });
  const bob = await hub.agent('bob', generateIdentity(), { state: store, renewKeysAfter: { messages: 2 }, fetch: counting });
  const epoch = () => hub.store.mlsLog(hub.store.dmGroups.get(dmPairKey(alice.did, bob.did)).group).epoch;

  for (const text of ['m1', 'm2', 'm3']) await alice.send(bob.did, note(text));
  assert.equal(epoch(), 1);
  // Alice has used her keys three times: before the fourth message she renews them.
  await alice.send(bob.did, note('m4'));
  assert.equal(epoch(), 2);
  // Bob's turn comes after reading two. He is behind the group then - alice has renewed since - and
  // the hub turns his commit away. He does not insist with every message: he tries again when he
  // has caught up, at the fourth, the first one he reads in the epoch the group is in.
  const read = await bob.poll();
  assert.deepEqual([texts(read), read.errors], [['m1', 'm2', 'm3', 'm4'], []]);
  assert.equal(epoch(), 3);
  assert.equal(tries.length, 2, 'one attempt per epoch he was in, not one per message');
  // Alice follows bob's renewal when she next writes, and each one's count has started again.
  await alice.send(bob.did, note('m5'));
  assert.deepEqual(texts(await bob.poll()), ['m5']);
  assert.equal(epoch(), 3);

  // By time: a reader that last renewed longer ago than the limit does it before it writes again.
  const record = JSON.parse(Buffer.from(store.get(`dm/${alice.did}`)).toString());
  assert.deepEqual(Object.keys(record.renewal), ['group', 'used', 'since']);
  store.set(`dm/${alice.did}`, Buffer.from(JSON.stringify({ ...record, renewal: { ...record.renewal, since: new Date(Date.now() - 8 * 86_400_000).toISOString() } })));
  await bob.send(alice.did, note('una semana después'));
  assert.equal(epoch(), 4);
  assert.deepEqual(texts(await alice.poll()), ['una semana después']);

  assert.throws(() => new AgentClient({ hubUrl: hub.url, mls: true, renewKeysAfter: { messages: 0 } }), /renewKeysAfter/);
  assert.throws(() => new AgentClient({ hubUrl: hub.url, mls: true, renewKeysAfter: { days: -1 } }), /renewKeysAfter/);
});

test('a renewal whose answer never arrives is not lost, and is not made twice', async (t) => {
  const hub = await startHub(t);
  const store = observableStore();
  const bobIdentity = generateIdentity();
  const alice = await hub.agent('alice', generateIdentity(), MLS);
  const bob = await hub.agent('bob', bobIdentity, { state: store });
  await alice.send(bob.did, note('uno'));
  assert.deepEqual(texts(await bob.poll()), ['uno']);
  const conversation = () => hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));
  const { group } = conversation();
  const log = () => hub.store.mlsLog(group);
  const pending = () => {
    const saved = store.get(`pending/${group}`);
    return saved ? JSON.parse(Buffer.from(saved).toString()) : null;
  };
  // Bob on a bad connection: his commits are lost on the way there, or their answers on the way back.
  let lost = null;
  const badConnection = async (url, init) => {
    const isCommit = init.method === 'POST' && new URL(url).pathname.endsWith('/commits');
    if (isCommit && lost === 'request') throw new TypeError('fetch failed');
    const res = await fetch(url, init);
    if (isCommit && lost === 'answer') throw new TypeError('fetch failed');
    return res;
  };
  const unlucky = hub.client(bobIdentity, { state: store, fetch: badConnection });

  // The hub takes his commit and he never hears of it. He kept it, and that is how he goes on:
  // when alice writes with the new keys, he finds his own commit in the log.
  lost = 'answer';
  await rejects(unlucky.renewConversationKeys(alice.did), 0, 'hub_unreachable');
  assert.equal(log().epoch, 2);
  assert.equal(pending().commit, log().commits[0].message);
  await alice.send(bob.did, note('dos'));
  assert.deepEqual(texts(await unlucky.poll()), ['dos']);
  assert.equal(pending(), null);
  assert.equal(await groupEpoch(store.get(`group/${group}`)), 2);

  // The commit never reaches the hub. The next attempt sends that same commit, not another:
  // two commits of one member in one epoch would be encrypted with the same key.
  lost = 'request';
  await rejects(unlucky.renewConversationKeys(alice.did), 0, 'hub_unreachable');
  assert.equal(log().epoch, 2);
  const kept = pending();
  assert.equal(kept.epoch, 2);
  lost = null;
  assert.deepEqual(await unlucky.renewConversationKeys(alice.did), { group, epoch: 3 });
  assert.equal(log().commits[1].message, kept.commit);
  assert.equal(pending(), null);

  // His commit is still unanswered when somebody else's ends the epoch. He drops his and follows theirs.
  lost = 'request';
  await rejects(unlucky.renewConversationKeys(alice.did), 0, 'hub_unreachable');
  assert.equal(pending().epoch, 3);
  await alice.renewConversationKeys(bob.did);
  await alice.send(bob.did, note('tres'));
  lost = null;
  assert.deepEqual(texts(await unlucky.poll()), ['tres']);
  assert.equal(pending(), null);
  await unlucky.send(alice.did, note('cuatro'));
  assert.deepEqual(texts(await alice.poll()), ['cuatro']);
  assert.equal(conversation().generation, 1, 'none of this cost a new group');
});

test('a commit that cannot be followed costs one new group, whoever notices first', async (t) => {
  const hub = await startHub(t);
  const store = observableStore();
  const aliceIdentity = generateIdentity();
  const bobIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity, MLS);
  const bob = await hub.agent('bob', bobIdentity, { state: store });
  await alice.send(bob.did, note('uno'));
  assert.deepEqual(texts(await bob.poll()), ['uno']);
  const conversation = () => hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));
  const first = conversation().group;

  // Bob's software misbehaves: it posts a commit of a group with the same name that only it knows.
  // The hub cannot tell - a commit is opaque to it - and takes it.
  const fake = await createUpdate((await createGroup(bobIdentity, first, [(await generateKeyPackage(aliceIdentity)).bytes])).state);
  const posted = await signedFetch(hub, bobIdentity, 'POST', `/v1/mls/dm/${alice.did}/commits`, { group: first, message: b64(fake.commit) });
  assert.deepEqual([posted.status, posted.json.epoch], [201, 2]);
  // Alice cannot apply it. Her next message goes to a new group, and the conversation carries on there.
  assert.equal((await alice.send(bob.did, note('dos'))).encryption, 'mls-v1');
  assert.deepEqual([conversation().generation, conversation().previous], [2, first]);
  assert.deepEqual(texts(await bob.poll()), ['dos']);
  const second = conversation().group;

  // The same when whoever cannot follow is reading, not writing. Bob renews, the answer is lost,
  // and so is his note of the commit: he can no longer follow the group he is in.
  let lost = true;
  const badConnection = async (url, init) => {
    const res = await fetch(url, init);
    if (lost && init.method === 'POST' && new URL(url).pathname.endsWith('/commits')) throw new TypeError('fetch failed');
    return res;
  };
  const unlucky = hub.client(bobIdentity, { state: store, fetch: badConnection });
  await rejects(unlucky.renewConversationKeys(alice.did), 0, 'hub_unreachable');
  lost = false;
  store.delete(`pending/${second}`);
  await alice.send(bob.did, note('tres'));
  // What alice sent with the new keys he cannot open. He makes the next group there and then...
  const stuck = await unlucky.poll();
  assert.deepEqual(stuck.messages, []);
  assert.deepEqual(stuck.errors.map(errorText), ['cannot decrypt (the keys of the conversation were renewed in a way this reader cannot follow)']);
  assert.deepEqual([conversation().generation, conversation().previous], [3, second]);
  // ...so that the next thing she sends reaches him.
  await alice.send(bob.did, note('cuatro'));
  assert.deepEqual(texts(await unlucky.poll()), ['cuatro']);
  assert.equal(conversation().generation, 3);

  // And the same when it is the hub that cannot be followed: it comes back from an old backup, and
  // where it says the group is, is behind where its members are. Nobody can go back to an epoch
  // it has left, so whoever writes next makes a new group.
  const third = conversation().group;
  await alice.renewConversationKeys(bob.did);
  hub.store.mlsLogs.set(third, { epoch: 1, commits: [] });
  assert.equal((await alice.send(bob.did, note('cinco'))).encryption, 'mls-v1');
  assert.deepEqual([conversation().generation, conversation().previous], [4, third]);
  assert.deepEqual(texts(await unlucky.poll()), ['cinco']);
});

test('a reader that is not in the group it is written in settles on the next, so that whoever writes finds out', async (t) => {
  const hub = await startHub(t);
  const alice = await hub.agent('alice', generateIdentity(), MLS);
  const bob = await hub.agent('bob', generateIdentity(), MLS);
  const kept = () => hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));
  // Alice writes to bob, and the invitation to their group never reaches him: there were too many
  // waiting for him, or the hub lost it. To alice the group looks as it should.
  await alice.send(bob.did, note('uno'));
  hub.store.welcomes.delete(bob.did);
  const first = await bob.poll();
  assert.deepEqual([first.messages, first.errors.map(errorText)], [[], ['cannot decrypt (this reader is not in that conversation group)']]);
  // He cannot read that one. He has made the next group, and what she writes from now on he reads.
  assert.equal(kept().generation, 2);
  await alice.send(bob.did, note('dos'));
  assert.deepEqual([texts(await bob.poll()), kept().generation], [['dos'], 2]);
  await bob.send(alice.did, note('tres'));
  assert.deepEqual([texts(await alice.poll()), kept().generation], [['tres'], 2]);
});

test('a message is not discarded because the hub failed to answer while it was being opened', async (t) => {
  const hub = await startHub(t);
  const alice = await hub.agent('alice', generateIdentity(), MLS);
  // What the connection does to the requests that opening a message can need: nothing, or `trouble()`.
  let trouble = null;
  const troubled = async (url, init) => {
    const path = new URL(url).pathname;
    const needed = init.method === 'GET' && (path === '/v1/mls/welcomes' || path.endsWith('/commits') || path.endsWith('/keys'));
    return (needed && trouble?.()) || fetch(url, init);
  };
  const answer = (status, code) => () => new Response(JSON.stringify({ error: { code, message: `hub says ${code}` } }), { status, headers: { 'content-type': 'application/json' } });
  const unreachable = () => {
    throw new TypeError('fetch failed');
  };
  const bob = await hub.agent('bob', generateIdentity(), { mls: true, fetch: troubled });
  const waiting = () => hub.store.pending(bob.did).length;
  const codes = (result) => result.errors.map((err) => err.code);

  // The first message of a conversation: opening it needs the invitation, which the hub holds.
  await alice.send(bob.did, note('uno'));
  trouble = unreachable;
  const first = await bob.poll();
  assert.deepEqual([first.messages, codes(first), waiting()], [[], ['retry_later'], 1], 'nothing was acknowledged');
  assert.match(first.errors[0].message, /^inbox entry 1 cannot be opened yet and stays in the inbox: cannot reach the hub/);
  trouble = null;
  assert.deepEqual(texts(await bob.poll()), ['uno']);
  assert.equal(waiting(), 0);

  // Keys renewed while he was away: opening needs the commit. A hub that answers with a failure of
  // its own is the same case. What comes after the entry waits with it, so the order holds.
  await alice.renewConversationKeys(bob.did);
  await alice.send(bob.did, note('dos'));
  await alice.send(bob.did, note('tres'));
  trouble = answer(500, 'internal_error');
  const second = await bob.poll();
  assert.deepEqual([second.messages, codes(second), waiting()], [[], ['retry_later'], 2]);
  trouble = null;
  assert.deepEqual(texts(await bob.poll()), ['dos', 'tres']);

  // An answer that does say something about the message - no such group - is final.
  await alice.renewConversationKeys(bob.did);
  await alice.send(bob.did, note('cuatro'));
  trouble = answer(404, 'group_not_found');
  const third = await bob.poll();
  assert.deepEqual([third.messages, codes(third), waiting()], [[], ['invalid_message'], 0]);
  assert.deepEqual(third.errors.map(errorText), ['cannot decrypt (hub says group_not_found)']);

  // And no entry is taken again for ever: at the fifth failure it is discarded, so that it cannot
  // hold back what follows.
  await alice.send(bob.did, note('cinco'));
  await alice.send(bob.did, note('seis'));
  trouble = unreachable;
  for (let attempt = 1; attempt < 5; attempt++) assert.deepEqual(codes(await bob.poll()), ['retry_later']);
  const fifth = await bob.poll();
  assert.deepEqual([codes(fifth), waiting()], [['invalid_message', 'retry_later'], 1]);
  assert.match(errorText(fifth.errors[0]), /^cannot decrypt \(cannot reach the hub/);
  trouble = null;
  assert.deepEqual(texts(await bob.poll()), ['seis']);

  // A client that starts anew every time it reads its inbox, as the command line does, counts the
  // attempts where it keeps its state: or it would never get to the fifth, and nothing behind that
  // entry would ever arrive.
  const daveIdentity = generateIdentity();
  const daveState = memoryStateStore();
  const anew = () => hub.client(daveIdentity, { state: daveState, fetch: troubled });
  await anew().register({ name: 'dave' });
  await alice.send(daveIdentity.did, note('a'));
  await alice.send(daveIdentity.did, note('b'));
  trouble = unreachable;
  for (let run = 1; run < 5; run++) assert.deepEqual(codes(await anew().poll()), ['retry_later'], `run ${run}`);
  assert.equal(daveState.keys('opening/').length, 1);
  const last = await anew().poll();
  assert.deepEqual([codes(last), hub.store.pending(daveIdentity.did).length, daveState.keys('opening/').length], [['invalid_message', 'retry_later'], 1, 1]);
  trouble = null;
  assert.deepEqual([texts(await anew().poll()), daveState.keys('opening/')], [['b'], []], 'and what opens in the end leaves no count behind');

  // Over the stream: the listener reports it, opens the stream again after a pause and takes the entry again.
  await alice.renewConversationKeys(bob.did);
  const got = [];
  const reported = [];
  const listener = bob.listen((message) => got.push(message.data.text), { onError: (err) => reported.push(err.code) });
  await listener.ready;
  trouble = () => {
    trouble = null;
    throw new TypeError('fetch failed');
  };
  await alice.send(bob.did, note('siete'));
  await alice.send(bob.did, note('ocho'));
  await until(() => got.length === 2);
  assert.deepEqual([got, reported], [['siete', 'ocho'], ['retry_later']]);
  await listener.close();

  // On a private topic with a topic key, what the hub is asked for is that key, and the same holds.
  const carol = await hub.agent('carol', generateIdentity(), { fetch: troubled });
  await alice.createTopic({ name: 'test.private.retry', description: 'A private topic used by this test', schema: { type: 'object' }, private: true, encryption: 'group', members: [carol.did] });
  await carol.subscribe('test.private.retry');
  await alice.publish('test.private.retry', { type: 'note', data: { text: 'nueve' } });
  trouble = unreachable;
  const held = await carol.poll();
  assert.deepEqual([held.messages, codes(held), hub.store.pending(carol.did).length], [[], ['retry_later'], 1]);
  trouble = null;
  assert.deepEqual(texts(await carol.poll()), ['nueve']);
});

test('what was read is handed over even when the hub cannot be told that it was', async (t) => {
  const hub = await startHub(t);
  const alice = await hub.agent('alice', generateIdentity(), MLS);
  let reachable = false;
  const flaky = async (url, init) => {
    if (!reachable && new URL(url).pathname === '/v1/inbox/ack') throw new TypeError('fetch failed');
    return fetch(url, init);
  };
  const bob = await hub.agent('bob', generateIdentity(), { mls: true, fetch: flaky });
  await alice.send(bob.did, note('uno'));

  // The message is opened, and then the acknowledgement does not get through. Over MLS it could
  // not be opened a second time, so failing here would lose it for good.
  const first = await bob.poll();
  assert.deepEqual([texts(first), first.errors], [['uno'], []]);
  assert.equal(hub.store.pending(bob.did).length, 1, 'the hub still holds it');
  // It comes again with the next call, is recognised, and this time the hub is told.
  reachable = true;
  await alice.send(bob.did, note('dos'));
  const second = await bob.poll();
  assert.deepEqual([texts(second), second.errors], [['dos'], []]);
  assert.equal(hub.store.pending(bob.did).length, 0);
});

test('a reader replaces the KeyPackages it can no longer open, so that the next invitation is one it can', async (t) => {
  const hub = await startHub(t);
  const alice = await hub.agent('alice', generateIdentity(), MLS);
  const bobIdentity = generateIdentity();
  await hub.agent('bob', bobIdentity, MLS);
  const published = [...hub.store.keyPackages.get(bobIdentity.did)];
  assert.equal(published.length, 10);

  // Bob loses his state: disk gone, identity kept. The hub holds ten KeyPackages whose secrets no
  // longer exist. His client notices - it has fewer secrets than the hub has KeyPackages - and replaces them.
  const again = hub.client(bobIdentity, { state: memoryStateStore() });
  await again.poll();
  const replaced = hub.store.keyPackages.get(bobIdentity.did);
  assert.equal(replaced.length, 10);
  assert.ok(replaced.every((entry) => !published.includes(entry)), 'none of the old ones is left');
  await alice.send(bobIdentity.did, note('hola'));
  assert.deepEqual(texts(await again.poll()), ['hola']);
  // A client that still has every secret leaves things as they are.
  await again.poll();
  assert.equal(hub.store.keyPackages.get(bobIdentity.did).filter((entry) => replaced.includes(entry)).length, 9, 'one was used by alice, and nothing else changed');

  // The other way to end up with one that cannot be opened: when a reader's KeyPackages run out,
  // the last is handed out again and again, and its secret is gone once the first invitation is opened.
  const carolIdentity = generateIdentity();
  const carol = await hub.agent('carol', carolIdentity, MLS);
  const drainer = generateIdentity();
  await hub.agent('drainer', drainer);
  for (let taken = 0; taken < 9; taken++) await signedFetch(hub, drainer, 'POST', `/v1/mls/dm/${carol.did}/key-packages`);
  const [last] = hub.store.keyPackages.get(carol.did);
  assert.equal(hub.store.keyPackages.get(carol.did).length, 1);
  const dave = await hub.agent('dave', generateIdentity(), MLS);
  const erin = await hub.agent('erin', generateIdentity(), MLS);
  await dave.send(carol.did, note('de dave'));
  await erin.send(carol.did, note('de erin'));
  assert.deepEqual(hub.store.keyPackages.get(carol.did), [last], 'both invitations were sealed to the same one');
  const mixed = await carol.poll();
  assert.deepEqual([texts(mixed), mixed.errors.map(errorText)], [['de dave'], ['cannot decrypt (this reader is not in that conversation group)']]);
  // That much is lost. But the KeyPackage that caused it does not stay there for the next one.
  const frank = await hub.agent('frank', generateIdentity(), MLS);
  await carol.poll();
  assert.ok(!hub.store.keyPackages.get(carol.did).includes(last));
  await frank.send(carol.did, note('de frank'));
  assert.deepEqual(texts(await carol.poll()), ['de frank']);

  // The hub takes `replace` from the reader the KeyPackages are for, and it is a yes or a no.
  const fresh = b64((await generateKeyPackage(carolIdentity)).bytes);
  const asCarol = (body) => signedFetch(hub, carolIdentity, 'POST', '/v1/mls/key-packages', body);
  assert.equal((await asCarol({ key_packages: [fresh], replace: 'yes' })).code, 'invalid_key_package');
  assert.deepEqual((await asCarol({ key_packages: [fresh], replace: true })).json, { count: 1 });
  assert.deepEqual(hub.store.keyPackages.get(carol.did), [fresh]);
});

test('what the envelope says and what MLS says must agree, and a hub cannot bring anyone else in', async (t) => {
  const hub = await startHub(t);
  const aliceStore = observableStore();
  const aliceIdentity = generateIdentity();
  const bobIdentity = generateIdentity();
  const malloryIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity, { state: aliceStore });
  const bob = await hub.agent('bob', bobIdentity, MLS);
  const mallory = await hub.agent('mallory', malloryIdentity, MLS);
  const laptopIdentity = instanceOf(aliceIdentity);
  const laptop = hub.client(laptopIdentity, MLS);
  await laptop.registerInstance();

  await alice.send(bob.did, note('para bob'));
  const genuine = hub.store.pending(bob.did)[0].envelope.event;
  await bob.poll();
  const at = () => new Date().toISOString();
  const wrap = (source, recipient, id, data) => ({ specversion: '1.0', id, source, type: 'agenthub.encrypted', time: at(), recipient, encryption: 'mls-v1', data });
  const reasons = (result) => result.errors.map(errorText);

  // Bob takes what alice wrote and sends it back to her side as his own words.
  const lifted = await signedFetch(hub, bobIdentity, 'POST', '/v1/messages', signEvent(wrap(bob.did, alice.did, 'lifted', genuine.data), bobIdentity));
  assert.equal(lifted.status, 202, 'the hub cannot tell: it is a well-formed message of that group');
  assert.deepEqual(reasons(await laptop.poll()), ['cannot decrypt (message was not made for this envelope)']);

  // Alice's agent key encrypts; the envelope is signed by her laptop. Same agent, but not the same member.
  const group = `group/${genuine.data.group}`;
  const made = await encryptMessage(aliceStore.get(group), new TextEncoder().encode(JSON.stringify(note('x'))), dmAad(alice.did, bob.did, 'crossed'));
  aliceStore.set(group, made.state);
  const crossed = await signedFetch(hub, laptopIdentity.instance, 'POST', '/v1/messages', signEvent(wrap(alice.did, bob.did, 'crossed', { group: genuine.data.group, message: b64(made.message) }), laptopIdentity));
  assert.equal(crossed.status, 202);
  assert.deepEqual(reasons(await bob.poll()), ['cannot decrypt (encrypted by a different member than the one that signed the envelope)']);

  // Mallory is not in the conversation. The hub refuses her message into its group...
  await mallory.send(bob.did, note('hola bob'));
  await bob.poll();
  const intruding = await signedFetch(hub, malloryIdentity, 'POST', '/v1/messages', signEvent(wrap(mallory.did, bob.did, 'intruder', genuine.data), malloryIdentity));
  assert.equal(`${intruding.status} ${intruding.code}`, '409 stale_group');
  // ...and if a dishonest hub delivered it anyway, bob would not take it for part of that conversation.
  const inbox = hub.store.inboxes.get(bob.did);
  const slip = (envelope) => inbox.items.push({ seq: inbox.next++, kind: 'direct', hub: { tier: 'key', received_at: at() }, envelope });
  slip(signEvent(wrap(mallory.did, bob.did, 'intruder', genuine.data), malloryIdentity));
  // A replay of something already read is dropped without a word; something never seen cannot be faked.
  slip(signEvent(genuine, aliceIdentity));
  slip(signEvent(wrap(alice.did, bob.did, 'garbage', { group: genuine.data.group, message: b64(new Uint8Array(40)) }), aliceIdentity));
  const slipped = await bob.poll();
  assert.deepEqual(slipped.messages, []);
  assert.deepEqual(reasons(slipped), ['cannot decrypt (that group is not the conversation with the sender)', 'cannot decrypt (not an MLS message)']);

  // A hub that hands out the wrong KeyPackage is caught by whoever makes the group.
  const carolIdentity = generateIdentity();
  await hub.agent('carol', carolIdentity, MLS);
  const dishonest = async (url, init) => {
    const res = await fetch(url, init);
    if (!String(url).endsWith('/key-packages') || init.method !== 'POST' || !String(url).includes('/v1/mls/dm/')) return res;
    const body = await res.json();
    body.key_packages[0].key_package = b64((await generateKeyPackage(malloryIdentity)).bytes); // mallory's, under carol's name
    return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
  };
  const deceived = await hub.agent('dave', generateIdentity(), { mls: true, fetch: dishonest });
  await assert.rejects(deceived.send(carolIdentity.did, note('hola')), /key package that does not belong to this conversation/);

  // A hub that points bob to a group somebody else made: the group says who is in it, and bob looks.
  const erinIdentity = generateIdentity();
  const erin = await hub.agent('erin', erinIdentity, MLS);
  const fake = dmGroupId(erin.did, bob.did, 1);
  const trap = await createGroup(malloryIdentity, fake, [bytes(hub.store.keyPackages.get(bob.did)[0])]);
  hub.store.dmGroups.set(dmPairKey(erin.did, bob.did), { group: fake, generation: 1, members: [erin.did, bob.did], previous: null });
  hub.store.welcomes.set(bob.did, [{ group: fake, welcome: b64(trap.welcome) }]);
  await assert.rejects(bob.send(erin.did, note('hola erin')), new RegExp(`holds ${mallory.did}, who is not part of the conversation`));
});

test('which group is current is the word of the hub: a reader writes only in one that is of the conversation, is not from before, and holds who it should', async (t) => {
  const hub = await startHub(t);
  const identities = { alice: generateIdentity(), bob: generateIdentity() };
  const state = memoryStateStore();
  let lie = null; // what the hub is made to say of the conversation of alice with bob, when it is not the truth
  let extra = null; // KeyPackages it hands out on top of the ones it should
  const written = []; // every message the client of alice sends
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const conversation = `/v1/mls/dm/${encodeURIComponent(identities.bob.did)}`;
  const dishonest = async (url, init) => {
    const { pathname } = new URL(url);
    if (init.method === 'POST' && pathname === '/v1/messages') written.push(JSON.parse(Buffer.from(init.body).toString('utf8')).event);
    const res = await fetch(url, init);
    if (!res.ok) return res;
    if (lie && init.method === 'GET' && pathname === conversation) return reply(lie(await res.json()));
    if (extra && init.method === 'POST' && pathname === `${conversation}/key-packages`) return reply({ key_packages: [...(await res.json()).key_packages, ...extra] });
    return res;
  };
  const alice = await hub.agent('alice', identities.alice, { state, fetch: dishonest });
  const bob = await hub.agent('bob', identities.bob, MLS);
  const mallory = await hub.agent('mallory', generateIdentity(), MLS);
  const readers = (truth) => [...truth.own_readers, ...truth.peer_readers];
  const kept = () => hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));
  const membersOf = async (group) => (await groupMembers(state.get(`group/${group}`))).map((member) => member.reader).sort();

  // Alice is in a group with mallory, and in another with bob.
  await mallory.send(alice.did, note('hola alice'));
  await alice.poll();
  const withMallory = hub.store.dmGroups.get(dmPairKey(alice.did, mallory.did)).group;
  assert.ok(state.get(`group/${withMallory}`));
  await alice.send(bob.did, note('uno'));
  const first = kept().group;
  assert.deepEqual([texts(await bob.poll()), written.map((event) => event.data.group)], [['uno'], [first]]);

  // "The group of your conversation with bob is that one": the one she has with mallory, or the
  // group of a topic. What she writes to bob would be read by whoever is in it. The name of a
  // group says which conversation it is of, and she looks before she writes.
  for (const group of [withMallory, topicGroupId('acme.plans.private', 1)]) {
    lie = (truth) => ({ ...truth, group, generation: 1, epoch: 1, members: readers(truth) });
    await assert.rejects(alice.send(bob.did, note('para quien no es')), /the hub names a group that is not of the conversation with did:key:/);
    await assert.rejects(alice.renewConversationKeys(bob.did), /the hub names a group that is not of the conversation with did:key:/);
  }
  assert.deepEqual([written.length, hub.store.pending(mallory.did).length], [1, 0], 'nothing was written anywhere');
  lie = null;

  // Bob starts an instance. "The group you have holds it already", says the hub, so that it never
  // gets to read; and it leaves alice out of her own readers. She is in the group whatever the hub
  // lists, and the group lacks somebody: she makes the next, with the instance in it.
  const serverIdentity = instanceOf(identities.bob);
  const server = hub.client(serverIdentity, MLS);
  await server.registerInstance();
  lie = (truth) => ({ ...truth, own_readers: [], members: readers(truth) });
  await alice.send(bob.did, note('dos'));
  const second = kept().group;
  assert.deepEqual([kept().generation, await membersOf(second), texts(await bob.poll()), texts(await server.poll())], [2, [alice.did, bob.did, server.instanceDid].sort(), ['dos'], ['dos']]);
  // Left out of her own readers again, and nothing else: the group is the one it should be, and she goes on in it.
  lie = (truth) => ({ ...truth, own_readers: [] });
  await alice.send(bob.did, note('dos y medio'));
  assert.deepEqual([kept().group, texts(await bob.poll()), texts(await server.poll())], [second, ['dos y medio'], ['dos y medio']]);
  // Then he removes it, and starts another: as many readers as there were, and not the same ones.
  await bob.removeInstance(server.instanceDid);
  const replacement = hub.client(instanceOf(identities.bob), MLS);
  await replacement.registerInstance();
  await replacement.poll(); // which leaves its KeyPackages on the hub
  // "That group holds just the readers there are now": so that she goes on writing where the
  // instance that was removed still reads. And, in case she makes another, a KeyPackage of that
  // instance among the ones handed out. It is the group that says who is in it, and only the
  // readers she was shown get into one she makes.
  lie = (truth) => ({ ...truth, members: readers(truth) });
  extra = [{ reader: server.instanceDid, key_package: b64((await generateKeyPackage(serverIdentity)).bytes) }, { reader: alice.did, key_package: hub.store.keyPackages.get(alice.did)[0] }];
  assert.equal((await alice.send(bob.did, note('tres'))).encryption, 'mls-v1');
  const third = written.at(-1).data.group;
  assert.deepEqual([parseDmGroupId(third).generation, await membersOf(third), texts(await bob.poll()), texts(await replacement.poll())], [3, [alice.did, bob.did, replacement.instanceDid].sort(), ['tres'], ['tres']]);
  extra = null;

  // She keeps the three groups. The hub takes her back: to the first, to the second, to none at
  // all, or to another one that it says is the third. What is written in a group from before is
  // read with older keys, by whoever was in it then.
  const back = [
    (truth) => ({ ...truth, group: first, generation: 1, epoch: 1, members: readers(truth) }),
    (truth) => ({ ...truth, group: second, generation: 2, epoch: 1, members: readers(truth) }),
    (truth) => ({ ...truth, group: null, generation: 0, epoch: 0, members: [] }),
    (truth) => ({ ...truth, group: dmGroupId(alice.did, bob.did, 3), epoch: 1, members: readers(truth) }),
  ];
  for (const said of back) {
    lie = said;
    const refused = await rejects(alice.send(bob.did, note('hacia atrás')), 409, 'mls_rollback_refused');
    assert.equal(refused.fromHub, false);
  }
  await rejects(alice.renewConversationKeys(bob.did), 409, 'mls_rollback_refused');
  // Nor a group and a generation that are not each other's, or a generation with no group.
  for (const said of [{ generation: 7 }, { group: null, generation: 7, epoch: 0, members: [] }]) {
    lie = (truth) => ({ ...truth, ...said });
    await assert.rejects(alice.send(bob.did, note('x')), /a group and a generation that do not go together/);
  }
  // State kept by a version that did not write down which group was the newest: it is worked out from the ones there are.
  const record = JSON.parse(Buffer.from(state.get(`dm/${bob.did}`)).toString('utf8'));
  assert.deepEqual(record.newest, { generation: 3, group: third });
  state.set(`dm/${bob.did}`, Buffer.from(JSON.stringify({ ...record, newest: undefined })));
  lie = back[0];
  await rejects(alice.send(bob.did, note('hacia atrás')), 409, 'mls_rollback_refused');
  assert.equal(written.length, 4, 'and nothing was written on the way');
  lie = null;

  // Which group is the newest does not change because a reader gets into an earlier one late. Erin
  // was away while alice wrote to her and then started an instance: she writes before she reads,
  // which takes her into the second group, and then opens what was waiting in the first.
  const erinState = memoryStateStore();
  const erin = await hub.agent('erin', generateIdentity(), { state: erinState });
  await alice.send(erin.did, note('a'));
  const laptop = hub.client(instanceOf(identities.alice), MLS);
  await laptop.registerInstance();
  await alice.send(erin.did, note('b'));
  const withErin = hub.store.dmGroups.get(dmPairKey(alice.did, erin.did));
  await erin.send(alice.did, note('c'));
  assert.deepEqual(texts(await erin.poll()), ['a', 'b']);
  const erinKeeps = JSON.parse(Buffer.from(erinState.get(`dm/${alice.did}`)).toString('utf8'));
  assert.deepEqual([erinKeeps.groups.map((group) => parseDmGroupId(group).generation), erinKeeps.newest], [[1, 2], { generation: 2, group: withErin.group }]);

  // A hub that lost its data and started over looks just the same. Told that it did, she forgets
  // the groups she kept of that conversation, and it starts again with a group of its own.
  assert.equal(await alice.forgetGroups(bob.did), 1);
  assert.deepEqual([state.keys('group/').filter((key) => key.includes(bob.did)), state.keys('group/').length, JSON.parse(Buffer.from(state.get(`dm/${bob.did}`)).toString('utf8'))], [[], 3, { groups: [] }]);
  assert.equal((await alice.send(bob.did, note('cuatro'))).encryption, 'mls-v1');
  assert.deepEqual([texts(await bob.poll()), kept().generation, written.at(-1).data.group], [['cuatro'], 4, kept().group]);
  // Every group at once. That she has talked to bob over MLS is not forgotten with them: a hub
  // that says he cannot any more does not get her to seal to his card unasked.
  assert.equal(await alice.forgetGroups(), 3);
  assert.deepEqual(state.keys('group/'), []);
  lie = (truth) => ({ ...truth, peer_readers: [] });
  await rejects(alice.send(bob.did, note('más débil')), 409, 'mls_downgrade_refused');
  await assert.rejects(alice.forgetGroups('nobody'), TypeError);
  await assert.rejects(bob.forgetGroups(`${alice.did}@`), TypeError);
  await assert.rejects(hub.client(generateIdentity()).forgetGroups(), /keeps no MLS state/);
});

test('an instance whose certificate runs out stops being a reader: it is not listed, not brought in, and not written to', async (t) => {
  const hub = await startHub(t);
  const identities = { alice: generateIdentity(), bob: generateIdentity() };
  let lie = null; // what the hub is made to say of the conversation of alice with bob, and to hand out on top of what it should
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const conversation = `/v1/mls/dm/${encodeURIComponent(identities.bob.did)}`;
  const dishonest = async (url, init) => {
    const res = await fetch(url, init);
    const { pathname } = new URL(url);
    if (!lie || !res.ok) return res;
    if (init.method === 'GET' && pathname === conversation) return reply(lie.view(await res.json()));
    if (init.method === 'POST' && pathname === `${conversation}/key-packages`) return reply({ key_packages: [...(await res.json()).key_packages, ...lie.extra] });
    return res;
  };
  const alice = await hub.agent('alice', identities.alice, { state: memoryStateStore(), fetch: dishonest });
  const bob = await hub.agent('bob', identities.bob, MLS);
  const kept = () => hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));
  // An instance of bob with a certificate that has three seconds left.
  const briefIdentity = instanceOf(identities.bob, { days: 1, now: Date.now() - 86_400_000 + 3000 });
  const expires = Date.parse(briefIdentity.certificate.certificate.expires_at);
  const brief = hub.client(briefIdentity, MLS);
  await brief.registerInstance();
  await brief.poll(); // which leaves its KeyPackages on the hub
  await alice.send(bob.did, note('uno'));
  const first = kept().group;
  assert.deepEqual([kept().members.includes(brief.instanceDid), texts(await brief.poll())], [true, ['uno']]);
  const itsKeyPackage = hub.store.keyPackages.get(brief.instanceDid)[0];
  await until(() => Date.now() > expires + 20, 6000);

  // The hub goes on listing it, says the group is as it should be, and hands out a KeyPackage of
  // it for the next one. It is still in the log of the hub, which keeps no dates. The certificate
  // says until when its agent answers for that key: she does not write where it reads, and it
  // does not get into the group she would make.
  lie = { view: (truth) => ({ ...truth, peer_readers: [bob.did, brief.instanceDid], members: [alice.did, bob.did, brief.instanceDid] }), extra: [{ reader: brief.instanceDid, key_package: itsKeyPackage }] };
  await assert.rejects(alice.send(bob.did, note('dos')), /key package that fails verification: the certificate of that instance has run out/);
  assert.deepEqual([kept().group, hub.store.pending(brief.instanceDid).length], [first, 0]);
  lie = null;
  // The hub itself: it no longer lists that instance among the readers that can be put in a group,
  // it does not take a group that has it, and the next group is made without it.
  const view = (await signedFetch(hub, identities.alice, 'GET', conversation)).json;
  assert.deepEqual([view.peer_readers, view.members.includes(brief.instanceDid)], [[bob.did], true]);
  const next = dmGroupId(alice.did, bob.did, 2);
  const withIt = await createGroup(identities.alice, next, [bytes(hub.store.keyPackages.get(bob.did)[0]), bytes(itsKeyPackage)]);
  const refused = await signedFetch(hub, identities.alice, 'PUT', conversation, { group: next, generation: 2, members: [alice.did, bob.did, brief.instanceDid], welcome: b64(withIt.welcome) });
  assert.deepEqual([refused.status, refused.code], [400, 'invalid_group']);
  await alice.send(bob.did, note('tres'));
  assert.deepEqual([kept().generation, kept().members.slice().sort(), texts(await bob.poll())], [2, [alice.did, bob.did].sort(), ['uno', 'tres']]);
});

test('the hub checks what it can of MLS: whose KeyPackages, which group, what kind of message', async (t) => {
  const hub = await startHub(t, { maxKeyPackagesPerReader: 4 });
  const aliceIdentity = generateIdentity();
  const bobIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity);
  const bob = await hub.agent('bob', bobIdentity);
  const mallory = await hub.agent('mallory');
  const as = (identity) => (method, path, body) => signedFetch(hub, identity, method, path, body);
  const packages = async (identity, count) => Promise.all(Array.from({ length: count }, async () => b64((await generateKeyPackage(identity)).bytes)));

  // KeyPackages: only one's own, only real ones, and not without end.
  const publish = (identity, list) => as(identity)('POST', '/v1/mls/key-packages', { key_packages: list });
  assert.equal((await publish(aliceIdentity, await packages(bobIdentity, 1))).code, 'invalid_key_package', 'somebody else\'s');
  assert.equal((await publish(aliceIdentity, [b64(new Uint8Array(50))])).code, 'invalid_key_package');
  assert.equal((await publish(aliceIdentity, ['not base64!'])).code, 'invalid_key_package');
  assert.equal((await publish(aliceIdentity, [])).code, 'invalid_key_package');
  assert.equal((await publish(aliceIdentity, await packages(aliceIdentity, 11))).code, 'invalid_key_package', 'more than ten at once');
  assert.equal((await publish(aliceIdentity, await packages(aliceIdentity, 3))).json.count, 3);
  assert.equal((await publish(aliceIdentity, await packages(aliceIdentity, 3))).json.count, 4, 'beyond the cap the oldest are dropped');
  assert.equal((await as(aliceIdentity)('GET', '/v1/mls/key-packages')).json.count, 4);
  assert.equal((await as(bobIdentity)('GET', '/v1/mls/key-packages')).json.count, 0);

  // Claiming uses each KeyPackage once, and keeps the last so the reader can still be reached.
  const claim = async () => (await as(bobIdentity)('POST', `/v1/mls/dm/${alice.did}/key-packages`)).json.key_packages;
  const handed = [];
  for (let i = 0; i < 5; i++) handed.push((await claim())[0].key_package);
  assert.equal(new Set(handed.slice(0, 4)).size, 4);
  assert.equal(handed[4], handed[3], 'the last one is handed out again rather than leaving the reader unreachable');
  assert.deepEqual((await claim()).map((entry) => entry.reader), [alice.did], 'bob has published none, and the one asking is never included');
  assert.equal((await as(bobIdentity)('POST', `/v1/mls/dm/${bob.did}/key-packages`)).code, 'invalid_parameter');
  assert.equal((await as(bobIdentity)('POST', `/v1/mls/dm/${generateIdentity().did}/key-packages`)).code, 'agent_not_found');

  // Making a group: the right generation, an id that names this pair, members that are its readers, a real invitation.
  await publish(bobIdentity, await packages(bobIdentity, 2));
  const view = (await as(bobIdentity)('GET', `/v1/mls/dm/${alice.did}`)).json;
  assert.deepEqual(view, { peer: alice.did, group: null, generation: 0, epoch: 0, members: [], own_readers: [bob.did], peer_readers: [alice.did] });
  const group = dmGroupId(alice.did, bob.did, 1);
  const { welcome } = await createGroup(bobIdentity, group, [bytes(handed[0])]);
  const create = (body) => as(bobIdentity)('PUT', `/v1/mls/dm/${alice.did}`, { group, generation: 1, members: [bob.did, alice.did], welcome: b64(welcome), ...body });
  assert.equal((await create({ generation: 2 })).code, 'stale_generation');
  assert.equal((await create({ group: dmGroupId(alice.did, mallory.did, 1) })).code, 'invalid_group');
  assert.equal((await create({ group: dmGroupId(alice.did, bob.did, 2) })).code, 'invalid_group');
  assert.equal((await create({ group: 'whatever' })).code, 'invalid_group');
  assert.equal((await create({ members: [bob.did, alice.did, mallory.did] })).code, 'invalid_group');
  assert.equal((await create({ members: [bob.did] })).code, 'invalid_group', 'the other side has to be in it');
  assert.equal((await create({ members: [alice.did] })).code, 'invalid_group', 'and so does whoever makes it');
  assert.equal((await create({ members: [bob.did, bob.did] })).code, 'invalid_group');
  assert.equal((await create({ welcome: handed[0] })).code, 'invalid_mls', 'a KeyPackage is not an invitation');
  assert.equal((await create({ welcome: 'no' })).code, 'invalid_mls');
  assert.equal((await create({})).status, 201);
  const taken = await create({});
  assert.equal(`${taken.status} ${taken.code}`, '409 stale_generation');
  assert.deepEqual([taken.json.error.generation, taken.json.error.group], [1, group]);

  // Invitations are handed to the reader they are for, and to nobody else.
  assert.deepEqual((await as(aliceIdentity)('GET', '/v1/mls/welcomes')).json.welcomes.map((entry) => entry.group), [group]);
  assert.deepEqual((await as(bobIdentity)('GET', '/v1/mls/welcomes')).json.welcomes, []);
  assert.equal((await as(generateIdentity())('GET', '/v1/mls/welcomes')).code, 'not_registered');
  await as(aliceIdentity)('POST', '/v1/mls/welcomes/ack', { group });
  assert.deepEqual((await as(aliceIdentity)('GET', '/v1/mls/welcomes')).json.welcomes, []);

  // Messages: an application message of the current group of that conversation, and nothing else.
  const state = (await createGroup(bobIdentity, group, [bytes(handed[1])])).state;
  const sealed = b64((await encryptMessage(state, new Uint8Array([1]), dmAad(bob.did, alice.did, 'm'))).message);
  const send = (data, id = 'm') => as(bobIdentity)('POST', '/v1/messages', signEvent({ specversion: '1.0', id, source: bob.did, type: 'agenthub.encrypted', time: new Date().toISOString(), recipient: alice.did, encryption: 'mls-v1', data }, bobIdentity));
  assert.equal((await send({ group, message: sealed })).status, 202);
  assert.equal((await send({ group, message: b64(welcome) }, 'w')).code, 'invalid_event', 'an invitation does not travel as a message');
  assert.equal((await send({ group, message: b64(new Uint8Array(30)) }, 'g')).code, 'invalid_event');
  assert.equal((await send({ group, message: sealed, extra: 1 }, 'x')).code, 'invalid_event');
  assert.equal((await send({ group: dmGroupId(alice.did, bob.did, 1), message: sealed }, 'o')).code, 'stale_group');
  const other = dmGroupId(alice.did, bob.did, 1);
  const elsewhere = b64((await encryptMessage((await createGroup(bobIdentity, other, [bytes(handed[2])])).state, new Uint8Array([1]), new Uint8Array())).message);
  assert.equal((await send({ group, message: elsewhere }, 'e')).code, 'invalid_event', 'the bytes must be of the group the envelope names');

  // One agent cannot use up another's KeyPackages: how many it may take, per peer, is limited.
  const strict = await startHub(t, { limits: { mlsClaim: { burst: 2, perMinute: 2 } } });
  const carolIdentity = generateIdentity();
  const carol = await strict.agent('carol', carolIdentity, { mls: true });
  const daveIdentity = generateIdentity();
  const dave = await strict.agent('dave', daveIdentity);
  const drain = () => signedFetch(strict, daveIdentity, 'POST', `/v1/mls/dm/${carol.did}/key-packages`);
  assert.deepEqual([(await drain()).status, (await drain()).status, (await drain()).code], [200, 200, 'rate_limited']);
  assert.equal(strict.store.keyPackages.get(carol.did).length, 8);
  assert.ok(dave.did);
  const erin = await strict.agent('erin', generateIdentity(), { mls: true });
  assert.equal((await signedFetch(strict, daveIdentity, 'POST', `/v1/mls/dm/${erin.did}/key-packages`)).status, 200, 'another peer is another budget');

  // A controller that does not allow direct messages does not allow conversations either.
  await bob.attachDelegation(createDelegation(generateIdentity(), { subject: bob.did, scope: { direct: false } }));
  assert.equal((await as(bobIdentity)('POST', `/v1/mls/dm/${alice.did}/key-packages`)).code, 'out_of_scope');
  assert.equal((await create({ generation: 2 })).code, 'out_of_scope');
});

test('the hub orders commits: one per epoch, from members only, and a message must be of the epoch its group is in', async (t) => {
  const hub = await startHub(t, { mlsCommitsKept: 2, mlsEarlierGroupsKept: 1 });
  const aliceIdentity = generateIdentity();
  const bobIdentity = generateIdentity();
  const malloryIdentity = generateIdentity();
  const alice = await hub.agent('alice', aliceIdentity);
  const bob = await hub.agent('bob', bobIdentity);
  await hub.agent('mallory', malloryIdentity);
  const as = (identity) => (method, path, body) => signedFetch(hub, identity, method, path, body);
  const commitAs = (identity, peer) => (body) => as(identity)('POST', `/v1/mls/dm/${peer}/commits`, body);
  const logAs = (identity, peer, query = '') => as(identity)('GET', `/v1/mls/dm/${peer}/commits${query}`);
  const messageAs = (identity, recipient) => (group, sealed, id) =>
    as(identity)('POST', '/v1/messages', signEvent({ specversion: '1.0', id, source: identity.did, type: 'agenthub.encrypted', time: new Date().toISOString(), recipient, encryption: 'mls-v1', data: { group, message: b64(sealed.message) } }, identity));
  const seal = (state, id) => encryptMessage(state, new Uint8Array([1]), dmAad(bob.did, alice.did, id));

  // A conversation made by hand: bob makes the group of each generation, alice joins it.
  const makeGroup = async (generation) => {
    const group = dmGroupId(alice.did, bob.did, generation);
    const invited = await generateKeyPackage(aliceIdentity);
    const made = await createGroup(bobIdentity, group, [invited.bytes]);
    const created = await as(bobIdentity)('PUT', `/v1/mls/dm/${alice.did}`, { group, generation, members: [bob.did, alice.did], welcome: b64(made.welcome) });
    assert.equal(created.status, 201);
    return { group, atBob: made.state, atAlice: (await joinGroup(aliceIdentity, made.welcome, invited.secret)).state };
  };
  const { group, atBob, atAlice } = await makeGroup(1);
  assert.equal((await as(aliceIdentity)('GET', `/v1/mls/dm/${bob.did}`)).json.epoch, 1);
  const byBob = await createUpdate(atBob);
  const byAlice = await createUpdate(atAlice);
  const post = commitAs(bobIdentity, alice.did);

  // Only a commit, of the current group of that conversation, from one of its members.
  assert.equal((await post({ group, message: b64((await seal(atBob, 'm')).message) })).code, 'invalid_mls', 'a message is not a commit');
  assert.equal((await post({ group, message: b64((await createGroup(bobIdentity, 'x', [(await generateKeyPackage(aliceIdentity)).bytes])).welcome) })).code, 'invalid_mls');
  assert.equal((await post({ group, message: b64(new Uint8Array(40)) })).code, 'invalid_mls');
  assert.equal((await post({ group, message: 'not base64!' })).code, 'invalid_mls');
  assert.equal((await post({ group })).code, 'invalid_mls');
  const elsewhere = await createUpdate((await createGroup(bobIdentity, 'another/group', [(await generateKeyPackage(aliceIdentity)).bytes])).state);
  assert.equal((await post({ group, message: b64(elsewhere.commit) })).code, 'invalid_mls', 'a commit of some other group');
  const unknown = await post({ group: dmGroupId(alice.did, bob.did, 1), message: b64(byBob.commit) });
  assert.deepEqual([unknown.status, unknown.code, unknown.json.error.group], [409, 'stale_group', group]);
  // Mallory cannot even name this conversation: what she posts goes to her own with alice, which has no group.
  assert.equal((await commitAs(malloryIdentity, alice.did)({ group, message: b64(byBob.commit) })).code, 'stale_group');
  // A reader of alice that is not in the group - an instance started after it was made - is no member of it.
  const laptopIdentity = instanceOf(aliceIdentity);
  await hub.client(laptopIdentity).registerInstance();
  const outsider = await signedFetch(hub, laptopIdentity.instance, 'POST', `/v1/mls/dm/${bob.did}/commits`, { group, message: b64(byAlice.commit) });
  assert.equal(`${outsider.status} ${outsider.code}`, '403 not_a_member');
  assert.equal(hub.store.mlsLog(group).epoch, 1, 'none of that moved the group');

  // One commit ends each epoch: the first to arrive. The other is told where the group is now.
  const won = await post({ group, message: b64(byBob.commit) });
  assert.deepEqual([won.status, won.json], [201, { group, epoch: 2 }]);
  const late = await commitAs(aliceIdentity, bob.did)({ group, message: b64(byAlice.commit) });
  assert.deepEqual([late.status, late.code, late.json.error.epoch], [409, 'stale_epoch', 2]);
  assert.equal((await post({ group, message: b64(byBob.commit) })).code, 'stale_epoch', 'nor the same one twice');
  assert.equal((await as(aliceIdentity)('GET', `/v1/mls/dm/${bob.did}`)).json.epoch, 2);

  // The log: the commit that ended each epoch, from the one a reader says it is in.
  assert.deepEqual((await logAs(aliceIdentity, bob.did, '?from=1')).json, { group, epoch: 2, commits: [{ epoch: 1, message: b64(byBob.commit) }] });
  assert.deepEqual((await logAs(aliceIdentity, bob.did)).json.commits.length, 1);
  assert.deepEqual((await logAs(aliceIdentity, bob.did, '?from=2')).json.commits, []);
  assert.deepEqual((await logAs(laptopIdentity.instance, bob.did, `?group=${encodeURIComponent(group)}`)).json.epoch, 2, 'any reader of the two agents may ask: it is ciphertext');
  assert.equal((await logAs(aliceIdentity, bob.did, '?from=x')).code, 'invalid_parameter');
  const missing = await logAs(aliceIdentity, bob.did, '?group=nope');
  assert.equal(`${missing.status} ${missing.code}`, '404 group_not_found');
  assert.equal((await logAs(malloryIdentity, alice.did)).code, 'group_not_found');
  assert.equal((await logAs(generateIdentity(), alice.did)).code, 'not_registered');
  // The commit in the log is the real thing: alice applies it and is where bob is.
  const aliceNext = await applyCommit(atAlice, bytes((await logAs(aliceIdentity, bob.did)).json.commits[0].message));
  assert.equal(aliceNext.epoch, 2);

  // Messages: of the epoch the group is in. One encrypted with the keys from before is turned away,
  // so that whoever writes has applied every commit and uses the newest keys.
  const send = messageAs(bobIdentity, alice.did);
  const stale = await send(group, await seal(atBob, 'old'), 'old');
  assert.deepEqual([stale.status, stale.code, stale.json.error.epoch], [409, 'stale_epoch', 2]);
  const fresh = await seal(byBob.state, 'new');
  assert.equal((await send(group, fresh, 'new')).status, 202);
  assert.equal(new TextDecoder().decode((await decryptMessage(aliceNext.state, fresh.message, dmAad(bob.did, alice.did, 'new'))).plaintext), '\u0001');

  // Only so many commits are kept (two, here): a reader further behind than that will not find the one it needs.
  let state = fresh.state;
  for (let epoch = 2; epoch <= 3; epoch++) {
    const next = await createUpdate(state);
    assert.deepEqual((await post({ group, message: b64(next.commit) })).json, { group, epoch: epoch + 1 });
    state = next.state;
  }
  assert.deepEqual((await logAs(aliceIdentity, bob.did, '?from=1')).json.commits.map((entry) => entry.epoch), [2, 3]);

  // When the conversation gets a new group, the one before keeps its log for a while: a reader may
  // still be opening what was sent in it. It takes no more commits, and its messages must be of its last epoch.
  const second = await makeGroup(2);
  assert.deepEqual((await as(aliceIdentity)('GET', `/v1/mls/dm/${bob.did}`)).json.epoch, 1, 'a new group starts over');
  assert.deepEqual((await logAs(aliceIdentity, bob.did)).json, { group: second.group, epoch: 1, commits: [] });
  assert.deepEqual((await logAs(aliceIdentity, bob.did, `?group=${encodeURIComponent(group)}&from=3`)).json, { group, epoch: 4, commits: [{ epoch: 3, message: hub.store.mlsLog(group).commits[1].message }] });
  assert.equal((await post({ group, message: b64((await createUpdate(state)).commit) })).code, 'stale_group');
  assert.equal((await send(group, await seal(state, 'last'), 'last')).status, 202, 'what was on its way to the group before still gets through');
  assert.equal((await send(group, await seal(byBob.state, 'older'), 'older')).code, 'stale_epoch');
  // One group back, here, and no further.
  const third = await makeGroup(3);
  assert.equal((await logAs(aliceIdentity, bob.did, `?group=${encodeURIComponent(group)}`)).code, 'group_not_found');
  assert.equal(hub.store.mlsLogs.has(group), false);
  assert.deepEqual((await logAs(aliceIdentity, bob.did, `?group=${encodeURIComponent(second.group)}`)).json.epoch, 1);
  assert.deepEqual([...hub.store.mlsLogs.keys()].sort(), [second.group, third.group].sort());

  // A controller that does not allow direct messages does not allow commits either.
  await bob.attachDelegation(createDelegation(generateIdentity(), { subject: bob.did, scope: { direct: false } }));
  assert.equal((await post({ group: third.group, message: b64((await createUpdate(third.atBob)).commit) })).code, 'out_of_scope');
  assert.equal(hub.store.mlsLog(third.group).epoch, 1);
});

test('without MLS on the other side a message is sealed to the card, unless told to insist', async (t) => {
  const hub = await startHub(t);
  const alice = await hub.agent('alice', generateIdentity(), MLS);
  const carol = await hub.agent('carol'); // keeps no MLS state

  const down = await alice.send(carol.did, note('para carol'));
  assert.equal(down.encryption, 'hpke-v1');
  const [got] = (await carol.poll()).messages;
  assert.deepEqual([got.data.text, got.encrypted, got.encryption], ['para carol', true, 'hpke-v1']);
  await rejects(alice.send(carol.did, { ...note('x'), encrypt: 'mls' }), 422, 'mls_unavailable');
  // The other way round carol seals to alice's card: alice's agent key opens it.
  assert.equal((await carol.send(alice.did, note('para alice'))).encryption, 'hpke-v1');
  assert.deepEqual((await alice.poll()).messages.map((message) => [message.data.text, message.encryption]), [['para alice', 'hpke-v1']]);
  const refused = await rejects(carol.send(alice.did, { ...note('x'), encrypt: 'mls' }), 422, 'mls_unavailable');
  assert.match(refused.message, /keeps no MLS state/);

  // Two clients that could use MLS can still be told not to, and plain stays plain.
  const bobIdentity = generateIdentity();
  const bob = await hub.agent('bob', bobIdentity, MLS);
  assert.equal((await alice.send(bob.did, { ...note('sellado'), encrypt: 'hpke' })).encryption, 'hpke-v1');
  assert.equal((await alice.send(bob.did, { ...note('en claro'), encrypt: false })).encryption, null);
  assert.equal((await alice.send(bob.did, note('mls'))).encryption, 'mls-v1');
  assert.deepEqual((await bob.poll()).messages.map((message) => message.encryption), ['hpke-v1', null, 'mls-v1']);

  // Whether the other side can do MLS is the hub's word. Once a conversation has used MLS, a hub
  // that says "not any more" does not get the message sealed the weaker way behind the sender's back.
  const lying = async (url, init) => {
    const res = await fetch(url, init);
    if (!/\/v1\/mls\/dm\/[^/]+$/.test(String(url)) || init.method !== 'GET') return res;
    return new Response(JSON.stringify({ ...(await res.json()), peer_readers: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const daveStore = memoryStateStore();
  const daveIdentity = generateIdentity();
  const dave = await hub.agent('dave', daveIdentity, { state: daveStore });
  assert.equal((await dave.send(bob.did, note('hola bob'))).encryption, 'mls-v1');
  const deceived = hub.client(daveIdentity, { state: daveStore, fetch: lying });
  await rejects(deceived.send(bob.did, note('degradado')), 409, 'mls_downgrade_refused');
  // Asked for MLS and nothing else, the answer is that there is nobody to do it with: nothing was going to be moved.
  await rejects(deceived.send(bob.did, { ...note('solo mls'), encrypt: 'mls' }), 422, 'mls_unavailable');
  assert.equal((await deceived.send(bob.did, { ...note('a sabiendas'), encrypt: 'hpke' })).encryption, 'hpke-v1');
  // With somebody it has never talked to over MLS there is nothing to compare with: it falls back.
  assert.equal((await deceived.send(alice.did, note('primera vez'))).encryption, 'hpke-v1');
  await bob.poll();

  // An MLS message read by a client that keeps no MLS state is reported as what it is.
  await alice.send(bob.did, note('otra'));
  const stateless = hub.client(bobIdentity);
  assert.equal(stateless.mlsEnabled, false);
  const unread = await stateless.poll();
  assert.deepEqual(unread.messages, []);
  assert.deepEqual(unread.errors.map(errorText), ['cannot decrypt (this client keeps no MLS state)']);
});

test('MLS state survives restarts of the client and of the hub, and losing it costs one new group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-mls-'));
  const options = { port: 0, quiet: true, powDifficulty: 8, dataDir: join(dir, 'hub') };
  const aliceIdentity = generateIdentity();
  const bobIdentity = generateIdentity();
  const laptopIdentity = instanceOf(aliceIdentity);
  const running = [];
  // New client objects every time, as after a restart of each process: all they share is what is on disk.
  const clients = (hub) => {
    const client = (identity, name) => new AgentClient({ hubUrl: hub.url, identity, state: fileStateStore(join(dir, `${name}.state`)) });
    return { alice: client(aliceIdentity, 'alice'), bob: client(bobIdentity, 'bob'), laptop: client(laptopIdentity, 'laptop') };
  };
  const boot = async () => {
    const hub = await createHub(options).listen();
    running.push(hub);
    return { hub, ...clients(hub) };
  };
  try {
    let { hub, alice, bob, laptop } = await boot();
    await alice.register({ name: 'alice' });
    await bob.register({ name: 'bob' });
    await laptop.registerInstance();
    await alice.send(bob.did, note('uno'));
    assert.deepEqual(texts(await bob.poll()), ['uno']);
    const generation = () => hub.store.dmGroups.get(dmPairKey(alice.did, bob.did)).generation;
    assert.equal(generation(), 1);

    // What is on disk: one file per entry, for the owner only, and it changes with every message.
    const stateDir = join(dir, 'bob.state');
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    assert.ok(readdirSync(stateDir).every((name) => (statSync(join(stateDir, name)).mode & 0o777) === 0o600));
    const groupFile = join(stateDir, readdirSync(stateDir).find((name) => Buffer.from(name, 'base64url').toString().startsWith('group/')));
    const saved = readFileSync(groupFile);
    await bob.send(alice.did, note('dos'));
    assert.notDeepEqual(readFileSync(groupFile), saved);

    // The clients restart. The conversation carries on in the same group.
    ({ alice, bob, laptop } = clients(hub));
    assert.deepEqual(texts(await alice.poll()), ['dos']);
    await alice.send(bob.did, note('tres'));
    assert.deepEqual(texts(await bob.poll()), ['tres']);
    assert.equal(generation(), 1);

    // Alice renews her keys. The hub restarts, with the laptop not having picked up its invitation yet.
    const { group } = hub.store.dmGroups.get(dmPairKey(alice.did, bob.did));
    assert.deepEqual(await alice.renewConversationKeys(bob.did), { group, epoch: 2 });
    await Promise.all(running.splice(0).map((old) => old.close()));
    ({ hub, alice, bob, laptop } = await boot());
    assert.equal(hub.store.dmGroups.get(dmPairKey(alice.did, bob.did)).generation, 1);
    assert.equal(hub.store.mlsLog(group).epoch, 2, 'where the group is came back from the snapshot');
    assert.deepEqual(texts(await laptop.poll()), ['dos'], 'its invitation and its message were both waiting');
    // The laptop joins the group as it was born and finds in the log the commit it missed.
    await laptop.send(bob.did, note('cuatro'));
    assert.deepEqual(texts(await bob.poll()), ['cuatro']);
    assert.equal(hub.store.dmGroups.get(dmPairKey(alice.did, bob.did)).generation, 1);

    // Bob renews his, and this time the hub crashes: it never shuts down, so the commit has to
    // come back from the journal. The clients restart too, and each one goes on from what it saved.
    assert.deepEqual(await bob.renewConversationKeys(alice.did), { group, epoch: 3 });
    await alice.send(bob.did, note('cinco'));
    const logged = structuredClone(hub.store.mlsLog(group));
    hub.store.fd = null; // from here on the crashed hub must not touch the data directory
    ({ hub, alice, bob, laptop } = await boot());
    assert.deepEqual(hub.store.mlsLog(group), logged);
    assert.deepEqual(texts(await bob.poll()), ['cinco']);
    await laptop.send(bob.did, note('seis'));
    assert.deepEqual(texts(await bob.poll()), ['seis']);
    assert.equal(hub.store.dmGroups.get(dmPairKey(alice.did, bob.did)).generation, 1);

    // Bob loses his state: disk gone, identity kept. What was sent to the old group he cannot open...
    await alice.send(bob.did, note('perdido'));
    const amnesic = new AgentClient({ hubUrl: hub.url, identity: bobIdentity, state: fileStateStore(join(dir, 'bob-again.state')) });
    const lost = await amnesic.poll();
    assert.deepEqual(lost.messages, []);
    assert.deepEqual(lost.errors.map(errorText), ['cannot decrypt (this reader is not in that conversation group)']);
    // ...but his next message makes a new group, and the conversation goes on from there.
    await amnesic.send(alice.did, note('he vuelto'));
    assert.equal(hub.store.dmGroups.get(dmPairKey(alice.did, bob.did)).generation, 2);
    assert.deepEqual(texts(await alice.poll()), ['he vuelto']);
    await alice.send(bob.did, note('bienvenido'));
    assert.deepEqual(texts(await amnesic.poll()), ['bienvenido']);
  } finally {
    await Promise.all(running.map((hub) => hub.close()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI keeps MLS state next to the identity file, so separate runs hold one conversation', async (t) => {
  const hub = await startHub(t);
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = async (identity, ...args) => JSON.parse((await promisify(execFile)(process.execPath, [CLI, ...args, '--identity', join(dir, identity), '--hub', hub.url])).stdout);

  const reviewer = await run('reviewer.json', 'init', '--name', 'rust-reviewer');
  const builder = await run('builder.json', 'init', '--name', 'acme-builder');
  const sent = await run('builder.json', 'send', reviewer.did, '--type', 'question', '--data', '{"text":"¿revisas el PR 42?"}');
  assert.equal(sent.encryption, 'mls-v1');
  assert.ok(statSync(join(dir, 'builder.json.state')).isDirectory());
  const [question] = await run('reviewer.json', 'inbox');
  assert.deepEqual([question.data.text, question.encrypted, question.encryption, question.sender], ['¿revisas el PR 42?', true, 'mls-v1', builder.did]);
  // Another run of each command, another message: the state on disk is what connects them.
  assert.equal((await run('reviewer.json', 'send', builder.did, '--type', 'answer', '--data', '{"text":"sí"}')).encryption, 'mls-v1');
  assert.equal((await run('builder.json', 'send', reviewer.did, '--type', 'thanks', '--data', '{"text":"gracias"}')).encryption, 'mls-v1');
  assert.deepEqual((await run('builder.json', 'inbox')).map((message) => message.data.text), ['sí']);
  assert.deepEqual((await run('reviewer.json', 'inbox')).map((message) => message.data.text), ['gracias']);
  assert.equal(hub.store.dmGroups.get(dmPairKey(reviewer.did, builder.did)).generation, 1);

  // Renewing keys by hand, for when a copy of the state may have got out. The other side follows on its own.
  const { group } = hub.store.dmGroups.get(dmPairKey(reviewer.did, builder.did));
  assert.deepEqual(await run('reviewer.json', 'key', 'renew', builder.did), { group, epoch: 2 });
  assert.equal((await run('builder.json', 'send', reviewer.did, '--type', 'note', '--data', '{"text":"sigo"}')).encryption, 'mls-v1');
  assert.deepEqual((await run('reviewer.json', 'inbox')).map((message) => message.data.text), ['sigo']);
  assert.deepEqual([hub.store.mlsLog(group).epoch, hub.store.dmGroups.get(dmPairKey(reviewer.did, builder.did)).generation], [2, 1]);
  await assert.rejects(run('reviewer.json', 'key', 'renew', generateIdentity().did), (err) => /no active agent is registered/.test(err.stderr));
  await assert.rejects(run('reviewer.json', 'key', 'renew'), (err) => /agent DID/.test(err.stderr));

  // Forgetting the groups kept of a conversation, for a hub that had to start over: said with --yes, and the conversation starts again.
  const groupsKept = (identity) => readdirSync(join(dir, `${identity}.state`)).map((file) => Buffer.from(file, 'base64url').toString('utf8')).filter((key) => key.startsWith('group/'));
  assert.deepEqual(groupsKept('builder.json'), [`group/${group}`]);
  await assert.rejects(run('builder.json', 'key', 'forget', reviewer.did), (err) => /pass --yes if the hub that keeps it really had to start over/.test(err.stderr));
  await assert.rejects(run('builder.json', 'key', 'forget'), (err) => /agent DID/.test(err.stderr));
  assert.deepEqual([await run('builder.json', 'key', 'forget', reviewer.did, '--yes'), groupsKept('builder.json')], [{ forgotten: true }, []]);
  assert.deepEqual(await run('builder.json', 'key', 'forget', reviewer.did, '--yes'), { forgotten: false });
  assert.equal((await run('builder.json', 'send', reviewer.did, '--type', 'note', '--data', '{"text":"de nuevo"}')).encryption, 'mls-v1');
  assert.deepEqual([(await run('reviewer.json', 'inbox')).map((message) => message.data.text), hub.store.dmGroups.get(dmPairKey(reviewer.did, builder.did)).generation], [['de nuevo'], 2]);
  // And with the log of the hub, when it is the hub of this agent that started over: every group it keeps.
  assert.deepEqual([await run('reviewer.json', 'log', 'forget', '--yes'), groupsKept('reviewer.json')], [{ forgotten: true, groups: 1 }, []]);
});
