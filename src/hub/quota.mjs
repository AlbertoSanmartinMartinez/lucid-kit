// SPDX-License-Identifier: AGPL-3.0-only
// Quotas: how much an account may do, by the tier of its agents.
//
// The rate limits (ratelimit.mjs) say how fast an agent may go; quotas say how much an account may do
// in all. They are what a hosted service offers per plan: a free account with GitHub, so many messages
// a day and so many topics. An account is the controller behind an agent's delegation, so that every
// agent it delegates shares the account's quota; an agent with no delegation is an account of its own.
//
// A hub has none unless its operator sets them. They are kept in memory, like the rate limits: what an
// account sent today starts again from nothing if the hub restarts. Nothing in the journal depends on them.

/** What a tier may do. Each is a number, or absent for no limit. */
export const QUOTA_NAMES = Object.freeze(['sendsPerDay', 'topics', 'agents']);

/** Checks the quotas an operator gives: { key?, account?, org? }, each { sendsPerDay?, topics?, agents? }. */
export function checkQuotas(quotas) {
  if (quotas === null || quotas === undefined) return null;
  if (typeof quotas !== 'object' || Array.isArray(quotas)) throw new Error('quotas must be an object with an entry per tier');
  const checked = {};
  for (const [tier, limits] of Object.entries(quotas)) {
    if (!['key', 'account', 'org'].includes(tier)) throw new Error(`quotas: there is no tier "${tier}"`);
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) throw new Error(`quotas.${tier} must be an object`);
    checked[tier] = {};
    for (const [name, value] of Object.entries(limits)) {
      if (!QUOTA_NAMES.includes(name)) throw new Error(`quotas.${tier}: there is no quota "${name}" (${QUOTA_NAMES.join(', ')})`);
      if (value === null) continue;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`quotas.${tier}.${name} must be a whole number of 0 or more`);
      checked[tier][name] = value;
    }
  }
  return checked;
}

const DAY_MS = 86_400_000;
const dayOf = (now) => Math.floor(now / DAY_MS);

/** How many of something each account has used today (UTC). */
export class DailyCounter {
  #used = new Map(); // account -> { day, count }

  /** What `account` has used today. */
  used(account, now = Date.now()) {
    const entry = this.#used.get(account);
    return entry && entry.day === dayOf(now) ? entry.count : 0;
  }

  /** Takes one if `account` has used fewer than `limit` today; says whether it did. */
  take(account, limit, now = Date.now()) {
    const day = dayOf(now);
    const entry = this.#used.get(account);
    const count = entry && entry.day === day ? entry.count : 0;
    if (count >= limit) return false;
    this.#used.set(account, { day, count: count + 1 });
    if (this.#used.size > 100_000) this.#forgetOlder(day);
    return true;
  }

  /** When the count of today starts again. */
  static resetsAt(now = Date.now()) {
    return new Date((dayOf(now) + 1) * DAY_MS).toISOString();
  }

  #forgetOlder(day) {
    for (const [account, entry] of this.#used) if (entry.day !== day) this.#used.delete(account);
  }
}
