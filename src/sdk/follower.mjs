// SPDX-License-Identifier: Apache-2.0
// The part of a client that follows the transparency log of its hub.
//
// It keeps the last checkpoint it saw and the directory the log told up to there. Each time it
// catches up, it asks the hub what it signs for now, reads the entries that are new and applies
// them to its own copy: the root it works out has to be the one the hub signed. A hub therefore
// cannot take back or change anything this client has read, and cannot tell it an entry that
// does not follow from the ones before.
//
// Whose log it is, is settled the first time: the hub that signs the first checkpoint this client
// sees is the hub it holds to from then on, unless the application says which hub it should be.
//
// What it does not catch by itself is a hub that tells this client one log and other readers
// another, for as long as it keeps the two apart. Witnesses are for that: with the keys of the ones
// it trusts, this client takes the log only if enough of them have cosigned, not long ago, a
// checkpoint that the log it read begins with. A witness cosigns one list per hub, so the same
// witnesses cannot have cosigned what another reader was shown instead. What the hub shows of the
// last moments, after the newest cosigned checkpoint, is not covered yet: it will be at the next one,
// or this client will see then that it was shown something else.

import { Directory, entryLeaf, LogError, verifyCheckpoint } from '../core/log.mjs';
import { Frontier, verifyConsistency } from '../core/merkle.mjs';
import { checkSignatures, NOTE_COSIGNATURE, NOTE_ED25519, noteKeyId, parseCheckpoint, parseNote, parseVerifier } from '../core/note.mjs';
import { publicKeyBytesFromDid } from '../core/didkey.mjs';

const HEAD = 'log/head';
const DIRECTORY = 'log/directory';
const hex = (hash) => hash.toString('hex');
const CLOCK_SKEW_S = 60; // how far ahead of this clock a witness may be
/** How the log of a hub signs its checkpoints: under the DID of the hub, with its key. */
const logOf = (hub) => {
  const key = publicKeyBytesFromDid(hub);
  return { name: hub, type: NOTE_ED25519, key, id: noteKeyId(hub, NOTE_ED25519, key) };
};

export class LogFollower {
  #read; // (path) => what the hub answers to a GET, as JSON
  #store; // where what was read is kept between runs
  #maxAgeMs; // how long what was read is taken as current
  #hub; // the DID of the hub whose log this is; null until the first checkpoint
  #frontier = new Frontier();
  #directory = new Directory();
  #caughtUpAt = -Infinity;
  #absent = false; // the hub keeps no log
  #turn = Promise.resolve();
  #readText; // (path) => what the hub answers to a GET, as text
  #witnesses; // the witnesses this client trusts, as verifier keys; none if it asks for none
  #quorum; // how many of them have to have cosigned
  #witnessMaxAgeMs; // and how long ago at most
  #now;
  #witnessedSize = 0; // how much of the log it last saw cosigned

  /**
   * `witnesses` are the verifier keys of the witnesses this client trusts, as each prints its own;
   * `quorum`, how many of them have to have cosigned the log (more than half, unless said), within
   * the last `witnessMaxAgeMs`. With none, the log is taken on the word of the hub alone.
   */
  constructor({ read, readText = null, store, hub = null, maxAgeMs = 10_000, witnesses = [], quorum = null, witnessMaxAgeMs = 5 * 60_000, now = Date.now }) {
    this.#read = read;
    this.#readText = readText;
    this.#store = store;
    this.#maxAgeMs = maxAgeMs;
    this.#hub = hub;
    this.#now = now;
    this.#witnesses = witnesses.map((given) => {
      const verifier = parseVerifier(given);
      if (verifier.type !== NOTE_COSIGNATURE) throw new TypeError('a witness is given by the key it cosigns with, not by the key of a log');
      return verifier;
    });
    if (new Set(this.#witnesses.map((witness) => witness.name)).size !== this.#witnesses.length) throw new TypeError('each witness is given once');
    this.#quorum = quorum ?? Math.floor(this.#witnesses.length / 2) + 1;
    if (this.#witnesses.length > 0 && (!Number.isSafeInteger(this.#quorum) || this.#quorum < 1 || this.#quorum > this.#witnesses.length)) throw new TypeError('quorum is how many of the witnesses given have to have cosigned: one at least, all at most');
    if (this.#witnesses.length > 0 && typeof readText !== 'function') throw new TypeError('a client that asks for witnesses has to be able to read the checkpoint they cosigned');
    this.#witnessMaxAgeMs = witnessMaxAgeMs;
    const head = store.get(HEAD);
    if (head === null) return;
    const saved = JSON.parse(Buffer.from(head).toString('utf8'));
    if (hub !== null && saved.hub !== hub) throw new Error(`this client has followed the log of ${saved.hub}, and is now told its hub is ${hub}`);
    this.#hub = saved.hub;
    this.#frontier = new Frontier({ size: saved.size, hashes: saved.hashes.map((hash) => Buffer.from(hash, 'hex')) });
    this.#directory = Directory.fromJSON(JSON.parse(Buffer.from(store.get(DIRECTORY)).toString('utf8')));
  }

  /** The hub whose log this client follows, once it has seen a checkpoint of it. */
  get hub() {
    return this.#hub;
  }

  /** How far this client has read the log. */
  get size() {
    return this.#frontier.size;
  }

  /**
   * Forgets what was read, to start again from the first entry of whatever log the hub shows
   * next - and from whichever hub signs it, unless the application said which. For a hub that had
   * to start over, and only on the word of whoever runs this client: it is what a hub that
   * rewrote its log would like every reader to do.
   */
  forget({ hub = null } = {}) {
    this.#store.delete(HEAD);
    this.#store.delete(DIRECTORY);
    this.#hub = hub;
    this.#frontier = new Frontier();
    this.#directory = new Directory();
    this.#caughtUpAt = -Infinity;
    this.#absent = false;
    this.#witnessedSize = 0;
  }

  /**
   * The directory as the log of the hub tells it, read up to what the hub signed for no longer
   * than `maxAgeMs` ago - or just now, with `fresh`. Null if the hub keeps no log. Throws a
   * LogError if the log does not hold or is no longer the one this client had read.
   */
  async directory({ fresh = false } = {}) {
    if (fresh || this.#stale()) {
      // One at a time: two that read the same entries would both add them. Whoever waited behind
      // another finds the log read, and does not ask the hub again unless it wanted it just now.
      const turn = this.#turn.catch(() => {}).then(() => (fresh || this.#stale() ? this.#catchUp() : undefined));
      this.#turn = turn;
      await turn;
    }
    return this.#absent ? null : this.#directory;
  }

  #stale() {
    return Date.now() - this.#caughtUpAt > this.#maxAgeMs;
  }

  async #catchUp(again = 0) {
    if (again > 3) throw new LogError('the hub shows more of its log cosigned than it gives to read');
    let signed;
    try {
      signed = await this.#read('/v1/log/checkpoint');
    } catch (err) {
      if (err?.status !== 404) throw err;
      // A hub that keeps no log. One that kept it and stops showing it is another matter.
      if (this.#frontier.size > 0) throw new LogError('the hub kept a log and no longer shows it');
      if (this.#witnesses.length > 0) throw new LogError('the hub keeps no log for the witnesses this client asks for to have cosigned', 'log_unwitnessed');
      this.#absent = true;
      this.#caughtUpAt = Date.now();
      return;
    }
    const head = verifyCheckpoint(signed, this.#hub === null ? {} : { hub: this.#hub });
    if (!head.ok) throw new LogError(`the checkpoint of the hub does not hold: ${head.error}`);
    const have = this.#frontier.size;
    if (head.size < have) throw new LogError(`the hub signed for a log of ${have} entries and now signs for one of ${head.size}`);
    if (head.size === have) {
      if (!this.#frontier.root().equals(head.root)) throw new LogError('the hub now signs for another log of the same size');
    } else {
      // What is new is read into a copy: if it does not hold, none of it is kept. The statements
      // in it have to be made for the hub that signs for the log.
      const directory = Directory.fromJSON(this.#directory.toJSON(), { hub: head.hub });
      const frontier = new Frontier({ size: have, hashes: this.#frontier.hashes });
      while (frontier.size < head.size) {
        const { entries } = await this.#read(`/v1/log/entries?from=${frontier.size}&limit=200`);
        if (!Array.isArray(entries) || entries.length === 0) throw new LogError(`the hub signed for ${head.size} entries and gives ${frontier.size}`);
        for (const entry of entries.slice(0, head.size - frontier.size)) {
          await directory.apply(entry);
          frontier.append(entryLeaf(entry));
        }
      }
      if (!frontier.root().equals(head.root)) {
        throw new LogError(have === 0 ? 'the entries the hub gives are not the list it signed for' : 'what the hub signs for now is not the log this client had read with more entries after it');
      }
      this.#directory = directory;
      this.#frontier = frontier;
      // The directory first: a head without its directory could not be taken up again.
      this.#store.set(DIRECTORY, Buffer.from(JSON.stringify(directory.toJSON())));
      this.#store.set(HEAD, Buffer.from(JSON.stringify({ hub: head.hub, size: frontier.size, hashes: frontier.hashes.map(hex) })));
    }
    this.#hub = head.hub;
    this.#absent = false;
    if (this.#witnesses.length > 0 && !(await this.#heldToWitnesses())) {
      // What they cosigned is further on than what was read: the log grew meanwhile. Once more, from there.
      return this.#catchUp(again + 1);
    }
    this.#caughtUpAt = Date.now();
  }

  /**
   * Holds the log this client has read to what its witnesses cosigned. True if it holds; false if
   * what they cosigned goes further than what was read, and the log has to be read again. Throws a
   * LogError if not enough of them cosigned lately ("log_unwitnessed"), or if what they cosigned is
   * not the beginning of the log this client read ("log_invalid").
   */
  async #heldToWitnesses() {
    const checkpoint = await this.cosigned();
    if (checkpoint.size < this.#witnessedSize) throw new LogError(`the hub showed ${this.#witnessedSize} entries of its log cosigned and now shows ${checkpoint.size}`);
    const size = this.#frontier.size;
    if (checkpoint.size > size) return false;
    // What they cosigned has to be where the log this client read begins: the same hub with another
    // list for other readers could not have had that one cosigned by the same witnesses.
    let begins = checkpoint.size === size && this.#frontier.root().equals(checkpoint.root);
    if (checkpoint.size < size) {
      const { proof } = await this.#read(`/v1/log/consistency?first=${checkpoint.size}&second=${size}`);
      const hashes = Array.isArray(proof) && proof.every((hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) ? proof.map((hash) => Buffer.from(hash, 'hex')) : null;
      begins = hashes !== null && verifyConsistency({ first: checkpoint.size, second: size, firstRoot: checkpoint.root, secondRoot: this.#frontier.root(), proof: hashes });
    }
    if (!begins) throw new LogError('what the witnesses cosigned is not the log the hub shows this client');
    this.#witnessedSize = checkpoint.size;
    return true;
  }

  /**
   * The checkpoint of the log of `hub` that the hub shows cosigned, { size, root }, if enough of
   * the witnesses this client trusts cosigned it lately. It is of that hub's own log, and signed by
   * it. Throws a LogError if not ("log_unwitnessed"), or if what the hub shows is no such thing.
   * It reads none of the log: it is what whoever has not read it can still hold an answer to.
   */
  async cosigned(hub = this.#hub) {
    if (this.#witnesses.length === 0) throw new TypeError('this client asks for no witnesses');
    let note;
    try {
      note = await this.#readText('/v1/log/note');
    } catch (err) {
      if (err?.status !== 404) throw err;
      throw new LogError('the hub shows no checkpoint of its log that a witness has cosigned', 'log_unwitnessed');
    }
    let checkpoint;
    let seen;
    try {
      const { text, signatures } = parseNote(note);
      checkpoint = parseCheckpoint(text);
      seen = checkSignatures(text, signatures, { log: logOf(hub), witnesses: this.#witnesses });
    } catch {
      throw new LogError('the cosigned checkpoint the hub shows is not written or signed as one');
    }
    if (checkpoint.origin !== hub || !seen.byLog) throw new LogError('the cosigned checkpoint the hub shows is not one of its own log');
    const now = Math.floor(this.#now() / 1000);
    const lately = seen.cosigned.filter(({ time }) => time <= now + CLOCK_SKEW_S && now - time <= this.#witnessMaxAgeMs / 1000);
    if (lately.length < this.#quorum) {
      throw new LogError(`${lately.length} of the witnesses this client trusts cosigned the log of the hub lately, and it asks for ${this.#quorum}`, 'log_unwitnessed');
    }
    return checkpoint;
  }

  /** Whether this client asks for witnesses. */
  get asksForWitnesses() {
    return this.#witnesses.length > 0;
  }

  /** How much of the log this client last saw cosigned by the witnesses it asks for. */
  get witnessedSize() {
    return this.#witnessedSize;
  }
}
