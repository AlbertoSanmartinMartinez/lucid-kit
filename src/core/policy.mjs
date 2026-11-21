// SPDX-License-Identifier: Apache-2.0
// Who may publish to a topic, or subscribe to it.
//
// A policy is "any", "owner" (to publish only) or { min_tier, allow }: reaching the tier or being
// on the list is enough, and the owner always may. Its owner signs it (statement.mjs), so the hub
// and whoever signs have to write it the same way: this is that way.

import { isValidDid } from './didkey.mjs';
import { TIERS } from './delegation.mjs';
import { isPlainObject } from './proof.mjs';

/**
 * `value` as a policy is kept and signed: no policy at all counts as "any", and a list of DIDs
 * loses its repeats. Returns null if `value` is not a policy.
 */
export function normalizePolicy(value, { allowOwner }) {
  if (value === undefined || value === 'any') return 'any';
  if (value === 'owner' && allowOwner) return 'owner';
  if (!isPlainObject(value)) return null;
  const { min_tier: minTier, allow, ...rest } = value;
  if (Object.keys(rest).length > 0 || (minTier === undefined && allow === undefined)) return null;
  if (minTier !== undefined && (minTier === 'key' || !TIERS.includes(minTier))) return null;
  if (allow !== undefined && (!Array.isArray(allow) || allow.length > 200 || !allow.every(isValidDid))) return null;
  return { ...(minTier ? { min_tier: minTier } : {}), ...(allow ? { allow: [...new Set(allow)] } : {}) };
}
