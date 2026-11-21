// SPDX-License-Identifier: Apache-2.0
// Who a member of an MLS group is.
//
// MLS leaves "is this key really who it says it is?" to an Authentication Service. Here that
// service is the identity model the hub already has: a member is either an agent signing with
// its own key, or one of its instances, whose certificate the agent signed (core/instance.mjs).
//
// The credential is a basic credential whose identity is canonical JSON:
//   { "agent": "did:key:..." }                                  the agent key itself
//   { "agent": "did:key:...", "certificate": { ... } }          an instance, with its certificate
// and the member's MLS signature key must be the very key that DID or that certificate names.
// So a leaf in the group tree proves, on its own, which agent it speaks for.
//
// A certificate's dates are not checked when a credential is read. Leaves stay in a group long
// after they were added, and a certificate that runs out must not make the group unreadable for
// the rest. They are checked where they matter: an instance whose certificate has run out is not
// brought into a group (inspectKeyPackage), nobody writes in a group that still holds one
// (lapsedMembers), and what it may still send is decided on the envelope it signs.

import { canonicalize } from '../core/jcs.mjs';
import { publicKeyBytesFromDid } from '../core/didkey.mjs';
import { checkInstanceCertificate } from '../core/instance.mjs';

const MAX_CREDENTIAL_BYTES = 4096;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const rawPrivateKey = (privateKey) => new Uint8Array(Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url'));

/** What an identity (an agent's, or an instance's with its certificate) presents and signs with in MLS. */
export function credentialFor(identity) {
  const signer = identity.instance ?? identity;
  if (identity.instance && !identity.certificate) throw new Error('this instance has no certificate from its agent yet');
  const statement = identity.instance ? { agent: identity.did, certificate: identity.certificate } : { agent: identity.did };
  return {
    credential: { credentialType: 'basic', identity: new TextEncoder().encode(canonicalize(statement)) },
    signatureKeyPair: { signKey: rawPrivateKey(signer.privateKey), publicKey: new Uint8Array(publicKeyBytesFromDid(signer.did)) },
    member: { agent: identity.did, instance: identity.instance?.did ?? null, reader: signer.did },
  };
}

/**
 * When the certificate in a credential runs out, in milliseconds: never, for an agent that signs
 * with its own key. For a credential that readCredential has taken as good.
 */
export function certificateExpiry(credential) {
  const statement = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(credential.identity));
  return statement.certificate ? Date.parse(statement.certificate.certificate.expires_at) : Infinity;
}

/**
 * Returns { agent, instance, reader } for a credential and the signature key that goes with it,
 * or throws if the key is not the one the credential binds. `reader` is the DID the hub delivers to:
 * the instance, or the agent itself when it signs with its own key.
 */
export function readCredential(credential, signaturePublicKey) {
  if (credential?.credentialType !== 'basic' || !(credential.identity instanceof Uint8Array)) throw new Error('unsupported credential type');
  if (credential.identity.length > MAX_CREDENTIAL_BYTES) throw new Error('credential is too large');
  let statement;
  try {
    statement = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(credential.identity));
  } catch {
    throw new Error('credential is not valid JSON');
  }
  if (!isPlainObject(statement) || typeof statement.agent !== 'string') throw new Error('credential does not name an agent');
  const keys = Object.keys(statement);
  const sameKey = (did) => Buffer.from(signaturePublicKey).equals(publicKeyBytesFromDid(did));
  if (keys.length === 1) {
    if (!sameKey(statement.agent)) throw new Error('the signature key is not the key of the agent the credential names');
    return { agent: statement.agent, instance: null, reader: statement.agent };
  }
  if (keys.length !== 2 || !Object.hasOwn(statement, 'certificate')) throw new Error('credential has unexpected fields');
  const problem = checkInstanceCertificate(statement.certificate, { agent: statement.agent });
  if (problem) throw new Error(problem);
  const { instance } = statement.certificate.certificate;
  if (!sameKey(instance)) throw new Error('the signature key is not the key the instance certificate names');
  return { agent: statement.agent, instance, reader: instance };
}
