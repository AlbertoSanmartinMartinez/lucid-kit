// SPDX-License-Identifier: Apache-2.0
// Topic names.
//
// A topic lives on one hub, and there its name is dot-separated lowercase segments:
// "dev.rust.code-review.requests". Names are per hub: two hubs can each have a topic of the same
// name, and they are different topics.
//
// From a hub that is paired with the one a topic lives on, that topic is named "topic@peer", where
// `peer` is what the local operator calls the other hub. That is a local way of naming it and
// nothing more: the events of the topic carry its bare name, and say which hub it is of by that
// hub's DID, which is the same from everywhere.

export const TOPIC_NAME_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){1,15}$/;
export const PEER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Splits a topic name as an agent gives it. Returns { topic, peer }: `peer` is null for a topic of
 * the hub itself. Returns null if it is not a well-formed name.
 */
export function splitTopicName(name) {
  if (typeof name !== 'string' || name.length > 128 + 33) return null;
  const at = name.indexOf('@');
  const topic = at === -1 ? name : name.slice(0, at);
  const peer = at === -1 ? null : name.slice(at + 1);
  if (topic.length > 128 || !TOPIC_NAME_RE.test(topic)) return null;
  if (peer !== null && !PEER_NAME_RE.test(peer)) return null;
  return { topic, peer };
}

/** The name the events of a topic carry: its name on the hub it lives on, without the "@peer". */
export const bareTopicName = (name) => (typeof name === 'string' && name.includes('@') ? name.slice(0, name.indexOf('@')) : name);

/** The name by which a hub's agents call a topic of the hub it knows as `peer`. */
export const remoteTopicName = (topic, peer) => `${topic}@${peer}`;
