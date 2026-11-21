// SPDX-License-Identifier: Apache-2.0
// MLS (RFC 9420) behind an interface of our own.
//
// Everything the rest of the project knows about MLS goes through this file: bytes in, bytes out.
// The implementation underneath is ts-mls. It was chosen after checking that it interoperates with
// OpenMLS (experiments/mls-interop), so it can be swapped later without changing what travels.
//
// What is used of MLS, and what is not yet:
//   - KeyPackages, Welcome and application messages, with the per-message ratchet that gives
//     forward secrecy: a key that decrypted a message is gone once it has been used.
//   - Commits that renew a member's keys (an "update"): everyone moves to a new epoch whose keys
//     cannot be worked out from the old ones. That is what heals a group after a member's state
//     was copied: the copy stops following once that member has renewed. Commits are applied one
//     per epoch, in the order the hub fixes.
//   - What is needed to open messages of the last EPOCHS_RETAINED epochs is kept, because a message
//     may have been on its way when the keys were renewed. Only keys not used yet: one that opened
//     a message is gone in every epoch.
//   - Commits that bring members in or leave members out. Whether such a commit is acceptable is
//     not for this file to say: whoever applies one is asked, through `mayChange`, and by default
//     the answer is no. A group whose members never change by commit (a conversation between two
//     agents) simply never says yes.
//   - What is not used: proposals sent on their own, external commits, pre-shared keys, reinit.
//
// State is handled as opaque bytes. It holds the member's signature key: treat it like the identity file.

import { certificateExpiry, credentialFor, readCredential } from './credential.mjs';

export const MLS_SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'; // the mandatory suite of RFC 9420
const KEY_PACKAGE_DAYS = 90;
const DAY_S = 86_400;
// How many epochs back a member can still open a message, at most. Each epoch kept costs a copy of
// the tree in the saved state, about 1 KB per member, and the state is saved with every message:
// a large group keeps fewer, so that what is kept stays around LEAF_EPOCHS_RETAINED leaves in all.
export const EPOCHS_RETAINED = 16;
const LEAF_EPOCHS_RETAINED = 64;
/** The epochs a group of `leaves` members keeps: 16 up to 4 members, 8 for 8, 4 for 16, and never fewer than 2. */
export const epochsRetainedFor = (leaves) => Math.max(2, Math.min(EPOCHS_RETAINED, Math.floor(LEAF_EPOCHS_RETAINED / Math.max(leaves, 1))));

let loading;
/** ts-mls and the ciphersuite, loaded on first use: a hub or a client that never touches MLS never loads them. */
function load() {
  loading ??= (async () => {
    const [mls, keyPackage, privateMessage, welcome] = await Promise.all([import('ts-mls'), import('ts-mls/keyPackage.js'), import('ts-mls/privateMessage.js'), import('ts-mls/welcome.js')]);
    const impl = await mls.getCiphersuiteImpl(mls.getCiphersuiteFromName(MLS_SUITE));
    const authService = {
      async validateCredential(credential, signaturePublicKey) {
        try {
          readCredential(credential, signaturePublicKey);
          return true;
        } catch {
          return false;
        }
      },
    };
    const clientConfig = {
      keyRetentionConfig: { ...mls.defaultKeyRetentionConfig, retainKeysForEpochs: EPOCHS_RETAINED }, // decodeState sets it for the size of each group
      lifetimeConfig: mls.defaultLifetimeConfig,
      keyPackageEqualityConfig: mls.defaultKeyPackageEqualityConfig,
      paddingConfig: mls.defaultPaddingConfig,
      authService,
    };
    return {
      mls,
      impl,
      clientConfig,
      makeKeyPackageRef: keyPackage.makeKeyPackageRef,
      verifyKeyPackage: keyPackage.verifyKeyPackage,
      decryptSenderData: privateMessage.decryptSenderData,
      decryptGroupSecrets: welcome.decryptGroupSecrets,
      decryptGroupInfo: welcome.decryptGroupInfo,
    };
  })();
  return loading;
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const text = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));

function decode(mls, bytes, expected) {
  let decoded;
  try {
    decoded = mls.decodeMlsMessage(bytes, 0);
  } catch {
    decoded = undefined;
  }
  const message = decoded?.[0];
  if (!message || decoded[1] !== bytes.length) throw new Error('not an MLS message');
  if (message.version !== 'mls10') throw new Error('unsupported MLS version');
  if (expected && message.wireformat !== expected) throw new Error(`expected an MLS ${expected.replace('mls_', '').replace('_', ' ')}`);
  return message;
}

const encodeState = (mls, state) => mls.encodeGroupState(state);
/**
 * Decodes a copy of `bytes`, never `bytes` themselves. What ts-mls decodes are views into the
 * buffer it is given, and `wipe` below zeroes secrets in place: without the copy, an operation
 * would quietly damage the state it was handed, which the caller may still need - a commit that
 * the hub turns away leaves its maker in the state it had.
 */
function decodeState(mls, clientConfig, bytes) {
  const decoded = mls.decodeGroupState(Uint8Array.from(bytes), 0);
  if (!decoded) throw new Error('group state is damaged');
  const retainKeysForEpochs = epochsRetainedFor(leavesOf(decoded[0]).length);
  return { ...decoded[0], clientConfig: { ...clientConfig, keyRetentionConfig: { ...clientConfig.keyRetentionConfig, retainKeysForEpochs } } };
}

/** Zeroes the secrets an operation used up, in the decoded copy it worked on. */
const wipe = (mls, consumed) => consumed.forEach(mls.zeroOutUint8Array);

/** The leaves of a group that hold a member, each with its position: [{ index, leaf }]. A leaf is every other node of the tree. */
function leavesOf(state) {
  return state.ratchetTree.flatMap((node, position) => (position % 2 === 0 && node?.nodeType === 'leaf' ? [{ index: position / 2, leaf: node.leaf }] : []));
}

const memberAt = (leaf) => readCredential(leaf.credential, leaf.signaturePublicKey);

function membersOf(state) {
  return leavesOf(state).map(({ leaf }) => memberAt(leaf));
}

/** The member at leaf `index`, or undefined if that leaf is empty. */
function memberAtIndex(state, index) {
  const node = state.ratchetTree[index * 2];
  return node?.nodeType === 'leaf' ? memberAt(node.leaf) : undefined;
}

// --- key packages ------------------------------------------------------------------------

/**
 * A KeyPackage for `identity`: what others need to add it to a group while it is away.
 * Returns { bytes, ref, secret }: publish `bytes`, keep `secret` (under `ref`) until a Welcome uses it.
 */
export async function generateKeyPackage(identity, { now = Date.now() } = {}) {
  const { mls, impl, makeKeyPackageRef } = await load();
  const { credential, signatureKeyPair } = credentialFor(identity);
  const lifetime = { notBefore: BigInt(Math.floor(now / 1000) - 3600), notAfter: BigInt(Math.floor(now / 1000) + KEY_PACKAGE_DAYS * DAY_S) };
  const { publicPackage, privatePackage } = await mls.generateKeyPackageWithKey(credential, mls.defaultCapabilities(), lifetime, [], signatureKeyPair, impl);
  const bytes = mls.encodeMlsMessage({ keyPackage: publicPackage, wireformat: 'mls_key_package', version: 'mls10' });
  return {
    bytes,
    ref: hex(await makeKeyPackageRef(publicPackage, impl.hash)),
    secret: { key_package: Buffer.from(bytes).toString('base64url'), init: Buffer.from(privatePackage.initPrivateKey).toString('base64url'), hpke: Buffer.from(privatePackage.hpkePrivateKey).toString('base64url') },
  };
}

/**
 * Checks a published KeyPackage: right suite, signed by its own key, not expired, and a credential
 * that binds that key to an agent - with a certificate that has not run out, if it is an
 * instance: its agent answers for that key until then and no longer. Returns
 * { agent, instance, reader, ref }. Throws otherwise, with code "certificate_lapsed" if that
 * certificate is all that is wrong with it.
 */
export async function inspectKeyPackage(bytes, { now = Date.now() } = {}) {
  const { mls, impl, makeKeyPackageRef, verifyKeyPackage } = await load();
  const { keyPackage } = decode(mls, bytes, 'mls_key_package');
  if (keyPackage.cipherSuite !== MLS_SUITE) throw new Error('key package uses an unsupported ciphersuite');
  if (!(await verifyKeyPackage(keyPackage, impl.signature))) throw new Error('key package signature does not verify');
  const { lifetime } = keyPackage.leafNode;
  if (lifetime && BigInt(Math.floor(now / 1000)) > lifetime.notAfter) throw new Error('key package has expired');
  const member = readCredential(keyPackage.leafNode.credential, keyPackage.leafNode.signaturePublicKey);
  if (now > certificateExpiry(keyPackage.leafNode.credential)) throw Object.assign(new Error('the certificate of that instance has run out'), { code: 'certificate_lapsed' });
  return { ...member, ref: hex(await makeKeyPackageRef(keyPackage, impl.hash)) };
}

// --- groups ------------------------------------------------------------------------------

/**
 * Creates a group with `identity` and every member in `keyPackages` (bytes, already inspected).
 * Returns { state, welcome, members }: `welcome` lets the others join, `state` is this member's.
 * With nobody else the group holds its maker alone and there is no `welcome`. Either way it is
 * born at epoch 1.
 */
export async function createGroup(identity, groupId, keyPackages) {
  const { mls, impl, clientConfig } = await load();
  const own = await generateKeyPackage(identity);
  const ownPackage = decode(mls, own.bytes, 'mls_key_package').keyPackage;
  const privatePackage = privateOf(identity, own.secret);
  const alone = await mls.createGroup(new TextEncoder().encode(groupId), ownPackage, privatePackage, [], impl, clientConfig);
  const extraProposals = keyPackages.map((bytes) => ({ proposalType: 'add', add: { keyPackage: decode(mls, bytes, 'mls_key_package').keyPackage } }));
  const commit = await mls.createCommit({ state: alone, cipherSuite: impl }, { extraProposals, ratchetTreeExtension: true });
  wipe(mls, commit.consumed);
  return {
    state: encodeState(mls, commit.newState),
    welcome: commit.welcome ? mls.encodeMlsMessage({ welcome: commit.welcome, wireformat: 'mls_welcome', version: 'mls10' }) : null,
    members: membersOf(commit.newState),
  };
}

function privateOf(identity, secret) {
  const { signatureKeyPair } = credentialFor(identity);
  return { initPrivateKey: new Uint8Array(Buffer.from(secret.init, 'base64url')), hpkePrivateKey: new Uint8Array(Buffer.from(secret.hpke, 'base64url')), signaturePrivateKey: signatureKeyPair.signKey };
}

/** The refs of the KeyPackages a Welcome is addressed to: one of them should be ours. */
export async function welcomeRecipients(welcomeBytes) {
  const { mls } = await load();
  return decode(mls, welcomeBytes, 'mls_welcome').welcome.secrets.map((entry) => hex(entry.newMember));
}

/**
 * Joins the group a Welcome invites to, with the KeyPackage secret it was sealed to.
 * Returns { state, groupId, epoch, members, inviter }. Every member's credential has been checked
 * on the way in. `inviter` is the member that made the invitation: the one whose signature on the
 * description of the group inside it was verified. Whether that member had any business inviting
 * is for the caller to decide.
 */
export async function joinGroup(identity, welcomeBytes, secret) {
  const { mls, impl, clientConfig, makeKeyPackageRef, decryptGroupSecrets, decryptGroupInfo } = await load();
  const { welcome } = decode(mls, welcomeBytes, 'mls_welcome');
  const ownPackage = decode(mls, new Uint8Array(Buffer.from(secret.key_package, 'base64url')), 'mls_key_package').keyPackage;
  const state = await mls.joinGroup(welcome, ownPackage, privateOf(identity, secret), mls.emptyPskIndex, impl, undefined, undefined, clientConfig);
  // joinGroup verified who signed the invitation but does not say who it was. The invitation is
  // opened once more, with the library's own functions, only to read that.
  const initKey = await impl.hpke.importPrivateKey(privateOf(identity, secret).initPrivateKey);
  const secrets = await decryptGroupSecrets(initKey, await makeKeyPackageRef(ownPackage, impl.hash), welcome, impl.hpke);
  const info = secrets && (await decryptGroupInfo(welcome, secrets.joinerSecret, new Uint8Array(impl.kdf.size), impl));
  if (secrets) wipe(mls, [secrets.joinerSecret, ...(secrets.pathSecret ? [secrets.pathSecret] : [])]);
  const inviter = info && memberAtIndex(state, info.signer);
  if (!inviter) throw new Error('cannot tell which member made the invitation');
  return { state: encodeState(mls, state), groupId: text(state.groupContext.groupId), epoch: Number(state.groupContext.epoch), members: membersOf(state), inviter };
}

/** The epoch a group state is in. It starts at 1 and goes up by one with every commit. */
export async function groupEpoch(stateBytes) {
  const { mls, clientConfig } = await load();
  return Number(decodeState(mls, clientConfig, stateBytes).groupContext.epoch);
}

/**
 * Makes a commit that renews this member's keys. Returns { state, commit }: `state` is what this
 * member moves to IF the commit is the one accepted for the epoch; until then it keeps the old one.
 */
export async function createUpdate(stateBytes) {
  const { mls, impl, clientConfig } = await load();
  const result = await mls.createCommit({ state: decodeState(mls, clientConfig, stateBytes), cipherSuite: impl });
  wipe(mls, result.consumed);
  return { state: encodeState(mls, result.newState), commit: mls.encodeMlsMessage(result.commit) };
}

/**
 * Makes a commit that brings members in (`add`: their KeyPackages, already inspected) and leaves
 * members out (`remove`: their reader DIDs). Returns { state, commit, welcome, members }. As with
 * createUpdate, `state` is where this member goes IF the commit is the one accepted. `welcome`
 * invites those brought in, and is null when nobody is. `members` are the members afterwards.
 * A member can be left out and brought in again in one commit, with a new KeyPackage: that is how
 * one that lost its state gets back.
 */
export async function changeMembers(stateBytes, { add = [], remove = [] }) {
  const { mls, impl, clientConfig } = await load();
  const state = decodeState(mls, clientConfig, stateBytes);
  const leaves = leavesOf(state);
  const removals = remove.map((reader) => {
    const found = leaves.find(({ leaf }) => memberAt(leaf).reader === reader);
    if (!found) throw new Error(`${reader} is not in the group`);
    if (found.index === state.privatePath.leafIndex) throw new Error('a member cannot leave itself out');
    return { proposalType: 'remove', remove: { removed: found.index } };
  });
  const additions = add.map((bytes) => ({ proposalType: 'add', add: { keyPackage: decode(mls, bytes, 'mls_key_package').keyPackage } }));
  if (removals.length + additions.length === 0) throw new Error('nothing to change');
  const result = await mls.createCommit({ state, cipherSuite: impl }, { extraProposals: [...removals, ...additions], ratchetTreeExtension: true });
  wipe(mls, result.consumed);
  return {
    state: encodeState(mls, result.newState),
    commit: mls.encodeMlsMessage(result.commit),
    welcome: result.welcome ? mls.encodeMlsMessage({ welcome: result.welcome, wireformat: 'mls_welcome', version: 'mls10' }) : null,
    members: membersOf(result.newState),
  };
}

/**
 * The state a member moves to once its own commit is the one accepted: `nextStateBytes`, as
 * createUpdate or changeMembers returned it, without bringing back any key the member has used up since it made the
 * commit. Throws if that state does not follow from `stateBytes`.
 */
export async function adoptUpdate(stateBytes, nextStateBytes) {
  const { mls, clientConfig } = await load();
  const state = decodeState(mls, clientConfig, stateBytes);
  const next = decodeState(mls, clientConfig, nextStateBytes);
  const { epoch } = state.groupContext;
  const left = next.historicalReceiverData.get(epoch);
  if (!sameBytes(next.groupContext.groupId, state.groupContext.groupId) || next.groupContext.epoch !== epoch + 1n || !left) throw new Error('that state does not follow from this one');
  // `next` remembers the old epochs as they were when the commit was made. Messages opened since
  // used up keys that must stay used up: what is kept of each old epoch is taken from `state`.
  const kept = new Map(next.historicalReceiverData);
  for (const [earlier, data] of state.historicalReceiverData) if (kept.has(earlier)) kept.set(earlier, data);
  kept.set(epoch, { ...left, secretTree: state.secretTree });
  return encodeState(mls, { ...next, historicalReceiverData: kept });
}

/**
 * Applies a commit made by another member. Returns { state, epoch, sender, added, removed }.
 * A commit that only renews its maker's keys is always accepted. One that brings members in or
 * leaves members out is accepted only if `mayChange({ sender, added, removed })` says so; each of
 * those is a member, { agent, instance, reader }, and by default nobody may. Anything else a
 * commit can carry is refused. Throws if the commit is refused or does not verify, and with code
 * "left_out" if it is this member that the commit leaves out.
 */
export async function applyCommit(stateBytes, commitBytes, { mayChange = () => false } = {}) {
  const { mls, impl, clientConfig, decryptSenderData } = await load();
  const state = decodeState(mls, clientConfig, stateBytes);
  const { privateMessage } = decode(mls, commitBytes, 'mls_private_message');
  if (!sameBytes(privateMessage.groupId, state.groupContext.groupId)) throw new Error('commit belongs to a different group');
  if (privateMessage.contentType !== 'commit') throw new Error('not a commit');
  if (privateMessage.epoch !== state.groupContext.epoch) throw new Error(`commit is for epoch ${privateMessage.epoch}, this member is at ${state.groupContext.epoch}`);
  const senderData = await decryptSenderData(privateMessage, state.keySchedule.senderDataSecret, impl).catch(() => undefined);
  const sender = senderData === undefined ? undefined : memberAtIndex(state, senderData.leafIndex);
  if (!sender) throw new Error('cannot tell which member made the commit');
  const change = { added: [], removed: [] };
  let refusal = 'commit carries something other than a change of keys or of members';
  const decide = (incoming) => {
    if (incoming.kind !== 'commit') return 'reject';
    for (const { proposal } of incoming.proposals) {
      if (proposal.proposalType === 'add') {
        change.added.push(memberAt(proposal.add.keyPackage.leafNode));
      } else if (proposal.proposalType === 'remove') {
        const leaving = memberAtIndex(state, proposal.remove.removed);
        if (!leaving) return 'reject';
        change.removed.push(leaving);
      } else if (proposal.proposalType !== 'update') {
        return 'reject';
      }
    }
    if (change.added.length + change.removed.length === 0 || mayChange({ sender, ...change })) return 'accept';
    refusal = 'commit changes who is in the group in a way that is not accepted';
    return 'reject';
  };
  const result = await mls.processPrivateMessage(state, privateMessage, mls.emptyPskIndex, impl, decide);
  if (result.kind !== 'newState' || result.actionTaken !== 'accept') throw new Error(refusal);
  wipe(mls, result.consumed);
  // A member that the commit leaves out gets no further: the new keys were not sealed to it.
  if (result.newState.groupActiveState.kind !== 'active') throw Object.assign(new Error('this member was left out of the group'), { code: 'left_out' });
  return { state: encodeState(mls, result.newState), epoch: Number(result.newState.groupContext.epoch), sender, ...change };
}

/** The members of a group, as { agent, instance, reader }. */
export async function groupMembers(stateBytes) {
  const { mls, clientConfig } = await load();
  return membersOf(decodeState(mls, clientConfig, stateBytes));
}

/**
 * The readers in a group that are instances whose certificate has run out. They still read what
 * is written there: a group that holds one is not one to write in.
 */
export async function lapsedMembers(stateBytes, { now = Date.now() } = {}) {
  const { mls, clientConfig } = await load();
  return leavesOf(decodeState(mls, clientConfig, stateBytes))
    .filter(({ leaf }) => now > certificateExpiry(leaf.credential))
    .map(({ leaf }) => memberAt(leaf).reader);
}

// --- messages ----------------------------------------------------------------------------

/**
 * Encrypts `plaintext` for the group. `aad` is authenticated but not encrypted: it ties the
 * ciphertext to the envelope it travels in. Returns { state, message }: save `state` before sending.
 */
export async function encryptMessage(stateBytes, plaintext, aad) {
  const { mls, impl, clientConfig } = await load();
  const result = await mls.createApplicationMessage(decodeState(mls, clientConfig, stateBytes), plaintext, impl, aad);
  wipe(mls, result.consumed);
  return {
    state: encodeState(mls, result.newState),
    message: mls.encodeMlsMessage({ privateMessage: result.privateMessage, wireformat: 'mls_private_message', version: 'mls10' }),
  };
}

/**
 * Decrypts an application message. Returns { state, plaintext, sender }, `sender` being the member
 * that encrypted it, as its credential proves. Throws if the message is not for this group, was
 * not made for `aad`, has already been read, is of an epoch this member is not in and does not
 * keep, or does not decrypt. The key used is gone afterwards.
 */
export async function decryptMessage(stateBytes, messageBytes, aad) {
  const { mls, impl, clientConfig, decryptSenderData } = await load();
  const state = decodeState(mls, clientConfig, stateBytes);
  const { privateMessage } = decode(mls, messageBytes, 'mls_private_message');
  if (!sameBytes(privateMessage.groupId, state.groupContext.groupId)) throw new Error('message belongs to a different group');
  if (privateMessage.contentType !== 'application') throw new Error('not an application message');
  if (!sameBytes(privateMessage.authenticatedData, aad)) throw new Error('message was not made for this envelope');
  // Who sent it is read from the group as it was in the message's epoch: the current one, or an earlier one still kept.
  const current = privateMessage.epoch === state.groupContext.epoch;
  const then = current ? { senderDataSecret: state.keySchedule.senderDataSecret, ratchetTree: state.ratchetTree } : state.historicalReceiverData.get(privateMessage.epoch);
  if (!then) throw new Error(privateMessage.epoch > state.groupContext.epoch ? 'message is of an epoch this member has not reached' : 'message is of an epoch whose keys this member does not have');
  const senderData = await decryptSenderData(privateMessage, then.senderDataSecret, impl).catch(() => undefined);
  const sender = senderData === undefined ? undefined : memberAtIndex(then, senderData.leafIndex);
  if (!sender) throw new Error('cannot tell which member sent the message');
  const result = await mls.processPrivateMessage(state, privateMessage, mls.emptyPskIndex, impl);
  if (result.kind !== 'applicationMessage') throw new Error('not an application message');
  wipe(mls, result.consumed);
  return { state: encodeState(mls, result.newState), plaintext: result.message, sender };
}

/** What anyone relaying an MLS message can read from it without any key: its kind, group and epoch. */
export async function inspectMessage(bytes) {
  const { mls } = await load();
  const message = decode(mls, bytes);
  if (message.wireformat === 'mls_private_message') {
    const { groupId, epoch, contentType } = message.privateMessage;
    return { wireformat: 'private_message', groupId: text(groupId), epoch: Number(epoch), contentType };
  }
  if (message.wireformat === 'mls_welcome') return { wireformat: 'welcome', recipients: message.welcome.secrets.length };
  return { wireformat: message.wireformat.replace('mls_', '') };
}
