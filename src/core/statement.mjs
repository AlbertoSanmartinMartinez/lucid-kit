// SPDX-License-Identifier: Apache-2.0
// What an agent says about itself and what is its own, signed, for a hub to put on record.
//
// A hub records every change to its directory in its transparency log (log.mjs). Some changes
// come with something signed by whoever makes them: a card, a delegation, the certificate of an
// instance. These are the rest - creating a topic and changing who may use it, removing an
// instance, retiring, dropping a delegation. Signed, they stop being the hub's word for what an
// agent asked of it: a hub cannot write them on its own.
//
// A statement travels as { statement, proof } and is signed in a context of its own kind. It
// names the hub it is for, so that it means nothing on another. And each is made so that it can
// be used once: a topic is created once and each change to it is numbered, an instance that is
// removed does not come back, an agent that retires stays retired, and a delegation that is
// dropped cannot be presented again.
//
// It says what its signer decides, and as little as it can of what the hub told it. Whoever
// creates a topic knows all there is to say about it. Whoever changes one says what it changes
// and leaves the rest unsaid: a client that signed for "the topic as it is now" would be signing
// for whatever the hub had shown it.
//
// What a statement does not say is who may sign it. The key that signs is the agent's own or
// that of one of its instances - or, for handing an agent over, that of the guardian it named -
// and only whoever knows the instances and the guardian of the agent - the hub, a reader of its
// log - can tell whether that key speaks for it.

import { canonicalize } from './jcs.mjs';
import { CONTEXT, createProof, isBareProof, isPlainObject, verifyProof } from './proof.mjs';

// What each kind of statement says, besides the hub it is for:
//   topic.create     { topic, owner, contract, publish, subscribe, encryption }
//                    the contract of a topic (log.mjs, contractHash), who may publish and
//                    subscribe, and how it is encrypted, as whoever creates it has it.
//   topic.policy     { topic, owner, contract, encryption, publish, subscribe, revision }
//                    who may publish and subscribe from now on: null for the one that stays as
//                    it is. `contract` and `encryption` say which topic, and never change.
//                    `revision` is 1 for the first change of a topic and one more with each,
//                    so that an earlier one cannot be put back.
//   instance.remove  { agent, instance }
//   retire           { agent }
//   delegation.drop  { agent, issuer, delegation_id }
//   agent.guardian   { agent, guardian }
//                    who may hand the agent over to a successor from now on, instead of the
//                    agent itself: a key kept apart, or that of its controller. Said once.
//   agent.succeed    { agent, successor }
//                    the agent is handed over to another: signed by its guardian, or by the
//                    agent itself if it never named one. An agent is handed over once.
//   succession.accept  { agent, successor }
//                    the same, said by the successor: nobody is made the successor of another
//                    without signing for it.
const CONTEXTS = {
  'topic.create': CONTEXT.TOPIC,
  'topic.policy': CONTEXT.TOPIC_POLICY,
  'instance.remove': CONTEXT.INSTANCE_REMOVAL,
  retire: CONTEXT.RETIREMENT,
  'delegation.drop': CONTEXT.DELEGATION_DROP,
  'agent.guardian': CONTEXT.GUARDIAN,
  'agent.succeed': CONTEXT.SUCCESSION,
  'succession.accept': CONTEXT.SUCCESSION_ACCEPTANCE,
};

const stated = (hub, says) => ({ version: 1, hub, ...says });

/**
 * Signs a statement of `kind` for the hub `hub`: `says` is what it says. `signer` is the key that
 * signs, { did, privateKey }: the agent's own, or that of one of its instances.
 */
export function signStatement(kind, says, { hub, signer }) {
  const statement = JSON.parse(JSON.stringify(stated(hub, says))); // sign exactly what will travel as JSON
  return { statement, proof: createProof(CONTEXTS[kind], statement, signer) };
}

/**
 * Checks a statement of `kind` against what it is given for: it has to say exactly `says`, for
 * the hub `hub`, and nothing else. Returns { ok: true, signer } - the key that signed it; whether
 * that key speaks for the agent is for the caller to tell - or { ok: false, error }.
 */
export function verifyStatement(kind, envelope, { hub, says }) {
  if (!isPlainObject(envelope) || !isPlainObject(envelope.statement) || !isPlainObject(envelope.proof)) return { ok: false, error: 'a statement is { statement, proof }' };
  const { statement, proof } = envelope;
  let given;
  try {
    given = canonicalize(statement);
  } catch {
    return { ok: false, error: 'a statement is { statement, proof }' };
  }
  if (given !== canonicalize(stated(hub, says))) return { ok: false, error: 'it does not say what it is given for' };
  // Kept for good and shown to everybody, as it comes: nothing rides along in it.
  if (!isBareProof(proof)) return { ok: false, error: 'its proof has unexpected fields' };
  const verdict = verifyProof(CONTEXTS[kind], statement, proof);
  if (!verdict.ok) return { ok: false, error: `its signature is rejected: ${verdict.error}` };
  return { ok: true, signer: verdict.did };
}
