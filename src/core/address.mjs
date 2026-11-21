// SPDX-License-Identifier: Apache-2.0
// How an agent is addressed.
//
// An agent is its DID, wherever it is. To reach it, though, a hub has to know which hub it is
// on. An agent of the hub itself is addressed by its DID alone. One of a hub that this one is
// paired with is addressed as "did@peer", where `peer` is what the local operator calls that hub.
// Like the "@peer" of a topic, that is a local way of saying where: what identifies the other hub
// is its own DID, which a message for one of its agents carries.

import { isValidDid } from './didkey.mjs';
import { PEER_NAME_RE } from './topicname.mjs';

/**
 * Splits the address of an agent. Returns { did, peer }: `peer` is null for an agent of the hub
 * itself. Returns null if it is not an address.
 */
export function splitAgentAddress(address) {
  if (typeof address !== 'string' || address.length > 300) return null;
  const at = address.indexOf('@');
  const did = at === -1 ? address : address.slice(0, at);
  const peer = at === -1 ? null : address.slice(at + 1);
  if (!isValidDid(did) || (peer !== null && !PEER_NAME_RE.test(peer))) return null;
  return { did, peer };
}

/** The address of the agent `did` from a hub that calls its hub `peer`; its DID alone if `peer` is null. */
export const agentAddress = (did, peer) => (peer ? `${did}@${peer}` : did);
