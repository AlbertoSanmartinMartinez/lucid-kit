// SPDX-License-Identifier: Apache-2.0
// Private topics over MLS: names and rules shared by the hub and the SDK.
// Nothing here needs the MLS library.
//
// A private topic is one MLS group that holds every reader of every member agent: each agent's
// own key, if it is used, and each of its instances. Unlike a conversation between two agents,
// the group is changed rather than made again: a commit brings readers in and leaves them out.
//
// Who decides:
//   - The owner of the topic decides which agents are members. Its readers may bring in and leave
//     out anybody.
//   - Any other member agent looks after its own instances and nobody else: its readers may bring
//     in and leave out readers of that same agent.
// The hub is told what each commit does and holds its sender to these rules, but it cannot see
// inside a commit. What makes the rules hold is that every member checks them before applying
// one (`topicRule`), and that whoever joins checks who made its invitation (`mayInvite`).

import { randomBytes } from 'node:crypto';

export const TOPIC_MLS = 'mls-v1';
const PREFIX = 'agenthub/topic/v1';
const NONCE_RE = /^[A-Za-z0-9_-]{16}$/;

/** A fresh group id for the group of `topic` at `generation`. It says what it is for. */
export function topicGroupId(topic, generation) {
  return [PREFIX, topic, generation, randomBytes(12).toString('base64url')].join('|');
}

/** Returns { topic, generation } if `id` is a well-formed topic group id, or null. */
export function parseTopicGroupId(id) {
  if (typeof id !== 'string' || id.length > 400) return null;
  const [prefix, topic, generation, nonce, ...rest] = id.split('|');
  if (prefix !== PREFIX || rest.length > 0 || !topic || topic.length > 128) return null;
  if (!/^[1-9]\d{0,8}$/.test(generation ?? '') || !NONCE_RE.test(nonce ?? '')) return null;
  return { topic, generation: Number(generation) };
}

/** What ties an MLS ciphertext to the signed envelope that carries it: the topic, who publishes and the event id. */
export const topicAad = (topic, source, id) => new TextEncoder().encode(`${PREFIX}\n${topic}\n${source}\n${id}`);

/**
 * The rule every member applies to a commit that changes who is in the group of a topic owned by
 * `owner`. `sender`, `added` and `removed` are members: { agent, instance, reader }.
 */
export const topicRule =
  (owner) =>
  ({ sender, added, removed }) =>
    sender.agent === owner || [...added, ...removed].every((member) => member.agent === sender.agent);

/** Whether `inviter` could have invited a reader of agent `joiner` to the group of a topic owned by `owner`. */
export const mayInvite = (owner, inviter, joiner) => inviter.agent === owner || inviter.agent === joiner;
