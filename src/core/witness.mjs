// SPDX-License-Identifier: Apache-2.0
// What a witness of a transparency log does, as C2SP writes it (c2sp.org/tlog-witness).
//
// A log brings its latest checkpoint, the size of the one the witness cosigned last and a proof that
// the old one is the beginning of the new. The witness checks that the checkpoint is signed by the
// log, that the old size is the one it remembers, and the proof; then it remembers the new one and
// signs it with the time. It never signs for a log that does not follow from the one it signed
// before: that is the whole of what it is for.
//
// This is the part with no server in it: how a request is written and read, and what a witness
// answers to one, given what it remembers. Whoever calls it keeps what it remembers, and has to
// have written the new record down before letting the answer out.

import { EMPTY_ROOT, verifyConsistency } from './merkle.mjs';
import { checkSignatures, cosign, formatNote, formatSignatures, parseCheckpoint, parseNote } from './note.mjs';

const MAX_PROOF_LINES = 63;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,15})$/;
const canonicalHash = (line) => {
  const bytes = Buffer.from(line, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === line ? bytes : null;
};

/** What a log sends to a witness: the size it cosigned last, the proof from there, and the checkpoint as a note. */
export function formatAddCheckpoint({ old, proof, note }) {
  return `old ${old}\n${proof.map((hash) => `${hash.toString('base64')}\n`).join('')}\n${note}`;
}

/** Reads one: { old, proof, text, signatures }. Throws a TypeError if it is not written as one. */
export function parseAddCheckpoint(body) {
  const split = typeof body === 'string' ? body.indexOf('\n\n') : -1;
  if (split === -1) throw new TypeError('a request is an old size, a proof, a blank line and a checkpoint');
  const [first, ...lines] = body.slice(0, split).split('\n');
  const old = /^old (\S+)$/.exec(first)?.[1];
  const proof = lines.map(canonicalHash);
  if (old === undefined || !DECIMAL_RE.test(old) || lines.length > MAX_PROOF_LINES || proof.includes(null)) throw new TypeError('the old size and the proof are not written as they should be');
  return { old: Number(old), proof, ...parseNote(body.slice(split + 2)) };
}

/**
 * What a witness answers to a request.
 *   logs      the logs it watches: origin -> the verifier of the log (kind 01)
 *   latest    what it cosigned last for an origin: { size, root }, or null if nothing yet
 *   witness   its own name and key: { name, privateKey, key }
 * Returns { status, body, type } as the protocol says, and with a 200 also `record`, { origin, size,
 * root }: what it has to remember from now on. `refused` says why, for whoever runs it to read.
 */
export function answerAddCheckpoint(body, { logs, latest, witness, now = Date.now() }) {
  const plain = (status, refused) => ({ status, body: '', type: 'text/plain; charset=utf-8', refused });
  let request;
  let checkpoint;
  try {
    request = parseAddCheckpoint(body);
    checkpoint = parseCheckpoint(request.text);
  } catch (err) {
    return plain(400, err.message);
  }
  const log = logs.get(checkpoint.origin);
  if (!log) return plain(404, 'a log this witness does not watch');
  try {
    if (!checkSignatures(request.text, request.signatures, { log }).byLog) return plain(403, 'the checkpoint is not signed by its log');
  } catch {
    return plain(403, 'the signature of the log does not verify');
  }
  const { size, root } = checkpoint;
  if (request.old > size) return plain(400, 'the old size is greater than the size of the checkpoint');
  const known = latest(checkpoint.origin) ?? { size: 0, root: EMPTY_ROOT };
  if (request.old !== known.size) return { status: 409, body: `${known.size}\n`, type: 'text/x.tlog.size', refused: 'not the size this witness cosigned last' };
  if (size === 0 && !root.equals(EMPTY_ROOT)) return plain(422, 'an empty log with a root that is not that of an empty one');
  // From nothing, any log follows, and no proof is needed; from a log, only the one it is the beginning of.
  const follows = known.size === 0 ? request.proof.length === 0 : verifyConsistency({ first: known.size, second: size, firstRoot: known.root, secondRoot: root, proof: request.proof });
  if (!follows) return plain(422, 'the checkpoint does not follow from the one this witness cosigned last');
  return {
    status: 200,
    body: formatSignatures([cosign(request.text, witness, Math.floor(now / 1000))]),
    type: 'text/plain; charset=utf-8',
    record: { origin: checkpoint.origin, size, root },
  };
}

export { formatNote };
