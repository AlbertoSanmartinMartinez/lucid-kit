// SPDX-License-Identifier: Apache-2.0
// An agent as a record of OASF, the schema of the AGNTCY Directory.
//
// The Directory is where agents described by people who never met are published and found. What it
// keeps of each is a record of OASF: a name, a description, skills taken from a taxonomy of its own,
// and modules, one of which carries an A2A card. This writes that record around the A2A card an
// agent signed for its hub (a2a.mjs), in the shape of OASF 1.1.0 as the Directory's own tests write
// it. Publishing it, signing it and claiming it there is done with the Directory's tool (dirctl),
// by whoever runs the agent.
//
// What the record takes from the card it takes from one that verifies, and it says whose it is the
// way the Directory reads it: the agent's DID in the annotation it checks an identity claim against.
// What the card cannot say is asked of whoever exports it: the skills, which have to be entries of
// OASF's taxonomy and are not the words an agent describes itself with, and the authors.
//
// Not checked against OASF's validator nor against a Directory: neither could be reached or run
// where this was written. The shape was read from their repositories.

import { verifyA2ACard } from './a2a.mjs';
import { isValidDid } from './didkey.mjs';

export const OASF_VERSION = '1.1.0';
/** How the Directory's records name the version of an A2A 1.0 card. */
const A2A_CARD_VERSION = 'v1.0.0';
/** The annotations the Directory checks a claim of identity, and of ownership, against. */
export const OASF_IDENTITY = 'agntcy.dir/identity';
export const OASF_OWNER = 'agntcy.dir/owner';

const CLASS_RE = /^[a-z0-9_]{1,64}(\/[a-z0-9_]{1,64}){0,4}$/; // "software_engineering/code_quality/code_review"
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Entries of one of OASF's taxonomies: a name, or { name, id }, or "name=id" as it is typed in a command. */
function classes(given, what, { atLeastOne }) {
  if (!Array.isArray(given) || given.length > 50 || (atLeastOne && given.length === 0)) throw new TypeError(`${what} is a list of ${atLeastOne ? '1' : '0'} to 50 entries of the OASF taxonomy`);
  return given.map((entry) => {
    const [name, typed] = typeof entry === 'string' ? entry.split('=') : [entry?.name, entry?.id];
    const id = typed === undefined ? undefined : Number(typed);
    if (typeof name !== 'string' || !CLASS_RE.test(name)) throw new TypeError(`${what}: an entry is named as OASF names it, like "software_engineering/code_quality/code_review"`);
    if (id !== undefined && !(Number.isSafeInteger(id) && id > 0)) throw new TypeError(`${what}: the id of "${name}" is a positive integer`);
    return id === undefined ? { name } : { name, id };
  });
}

/**
 * The OASF record of the agent whose signed A2A card is `a2a`.
 *   skills   entries of OASF's taxonomy of skills, one at least
 *   authors  who answers for the record, each as OASF writes an author: "name <email>"
 *   domains  entries of its taxonomy of domains, if any
 *   owner    the DID that answers for the agent (its controller), if it is to be claimed in the Directory
 * Throws if the card is not signed by its agent, or if something asked for is missing.
 */
export function oasfRecord(a2a, { skills, authors, domains = [], owner } = {}) {
  const verdict = verifyA2ACard(a2a);
  if (!verdict.ok) throw new Error('an OASF record is made from an A2A card signed by its agent');
  if (!Array.isArray(authors) || authors.length < 1 || authors.length > 20 || !authors.every((author) => typeof author === 'string' && author.length >= 1 && author.length <= 200)) {
    throw new TypeError('authors is a list of 1 to 20 names, each of at most 200 characters');
  }
  if (owner !== undefined && !(isValidDid(owner) || /^did:web:[A-Za-z0-9.:%_-]{1,200}$/.test(owner))) throw new TypeError('owner is a did:key or a did:web');
  if (!DATETIME_RE.test(a2a.version) || Number.isNaN(Date.parse(a2a.version))) throw new Error('the card does not say when it was made');
  const address = `${verdict.hub}/a2a/${encodeURIComponent(verdict.did)}/`;
  return {
    name: a2a.name,
    schema_version: OASF_VERSION,
    version: a2a.version,
    description: a2a.description,
    authors: [...authors],
    created_at: a2a.version,
    annotations: { [OASF_IDENTITY]: verdict.did, ...(owner === undefined ? {} : { [OASF_OWNER]: owner }) },
    skills: classes(skills, 'skills', { atLeastOne: true }),
    ...(domains.length > 0 ? { domains: classes(domains, 'domains', { atLeastOne: false }) } : {}),
    locators: [{ type: 'url', urls: [address] }],
    modules: [{ name: 'integration/a2a', data: { card_data: a2a, card_schema_version: A2A_CARD_VERSION } }],
  };
}
