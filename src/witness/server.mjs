// SPDX-License-Identifier: AGPL-3.0-only
// A witness: a small service that watches transparency logs and cosigns what they are, for as long
// as each only grows (core/witness.mjs, c2sp.org/tlog-witness).
//
// A hub brings it its checkpoint every few seconds. A client that asks for witnesses takes the log of
// a hub only up to where enough of them have cosigned it, so a hub that showed one list to some
// readers and another to others would have to get both past the same witnesses, and cannot.
//
// It is meant to be run by somebody other than whoever runs the hub: a witness the operator of a hub
// runs next to it says nothing that the hub does not already say.
//
// What it keeps, on disk: its key, and for each log the last checkpoint it cosigned. That record is
// written before the cosignature leaves, so that a witness that stops and starts again remembers
// what it signed. A witness that loses it would cosign anything again from nothing: its data is to
// be kept as carefully as its key.
//
// The logs it watches are the ones it is told: anybody can ask, and nothing is cosigned that is not
// signed by one of them.

import { createServer } from 'node:http';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerAddCheckpoint } from '../core/witness.mjs';
import { formatVerifier, NOTE_COSIGNATURE, NOTE_ED25519, noteKeyId, parseVerifier, publicKeyBytes } from '../core/note.mjs';
import { isValidDid, publicKeyBytesFromDid } from '../core/didkey.mjs';
import { RateLimiter } from '../hub/ratelimit.mjs';

const MAX_BODY = 16 * 1024;
const MAX_LOGS = 10_000;
const DEFAULTS = {
  port: 8789,
  host: '127.0.0.1',
  dataDir: null, // null: nothing is kept, for tests
  name: null, // how it signs: a name of its own, like "witness.example/w1"
  logs: [], // the logs it watches: the DID of a hub, or the verifier key of any log
  quiet: false,
  limit: { burst: 60, perMinute: 600 }, // per client address
};

/** The log a witness is told to watch, from the DID of a hub or from a verifier key: { name, type, key, id }. */
export function logVerifier(given) {
  if (isValidDid(given)) {
    // The log of a hub is named by the key of the hub: it is the same log wherever the hub is reached.
    const key = publicKeyBytesFromDid(given);
    return { name: given, type: NOTE_ED25519, key, id: noteKeyId(given, NOTE_ED25519, key) };
  }
  const verifier = parseVerifier(given);
  if (verifier.type !== NOTE_ED25519) throw new TypeError('a log is given by the key it signs its checkpoints with, not by that of a witness');
  return verifier;
}

function loadOrCreateKey(dataDir) {
  const file = dataDir ? join(dataDir, 'witness-key.json') : null;
  if (file && existsSync(file)) return createPrivateKey({ key: JSON.parse(readFileSync(file, 'utf8')).private_key_jwk, format: 'jwk' });
  const { privateKey } = generateKeyPairSync('ed25519');
  if (file) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ private_key_jwk: privateKey.export({ format: 'jwk' }) }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return privateKey;
}

/** Writes `text` to `file` so that it is either the old contents or the new, and on disk before this returns. */
function writeDurably(file, text) {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export function createWitness(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const logs = new Map(cfg.logs.map(logVerifier).map((log) => [log.name, log]));
  if (logs.size === 0 || logs.size > MAX_LOGS) throw new Error('a witness is told which logs it watches: one at least');
  const privateKey = loadOrCreateKey(cfg.dataDir);
  const key = publicKeyBytes(createPublicKey(privateKey));
  const name = cfg.name ?? `agenthub-witness/${noteKeyId('agenthub-witness', NOTE_COSIGNATURE, key).toString('hex')}`;
  const witness = { name, privateKey, key };
  const verifier = formatVerifier({ name, type: NOTE_COSIGNATURE, key });

  // What was cosigned last for each log. All of it is in one small file: a witness watches few logs.
  const stateFile = cfg.dataDir ? join(cfg.dataDir, 'witness-state.json') : null;
  const latest = new Map();
  if (stateFile && existsSync(stateFile)) {
    for (const [origin, { size, root }] of Object.entries(JSON.parse(readFileSync(stateFile, 'utf8')))) latest.set(origin, { size, root: Buffer.from(root, 'base64') });
  }
  const remember = ({ origin, size, root }) => {
    const next = new Map(latest).set(origin, { size, root });
    if (stateFile) writeDurably(stateFile, `${JSON.stringify(Object.fromEntries([...next].map(([log, held]) => [log, { size: held.size, root: held.root.toString('base64') }])), null, 2)}\n`);
    latest.set(origin, { size, root });
  };

  const limiter = new RateLimiter();
  const log = (line) => cfg.quiet || console.log(`[witness] ${line}`);
  const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    const payload = Buffer.from(body, 'utf8');
    res.writeHead(status, { 'content-type': type, 'content-length': payload.length });
    res.end(payload);
  };

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://witness.invalid');
    if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, 'ok\n');
    // Who it is and what it watches: what a hub and its readers are given to trust it by.
    if (req.method === 'GET' && pathname === '/v1/info') return send(res, 200, `${JSON.stringify({ name, verifier, logs: [...logs.keys()] })}\n`, 'application/json; charset=utf-8');
    if (req.method !== 'POST' || pathname !== '/add-checkpoint') return send(res, 404, 'not found\n');
    if (!limiter.take(`ip:${req.socket.remoteAddress}`, cfg.limit)) return send(res, 429, 'too many requests\n');
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        send(res, 413, 'request too large\n');
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      // From here to the answer nothing waits: a request is read, judged and remembered before the
      // next one is looked at, so two of them cannot both be judged against the same record.
      let answer;
      try {
        answer = answerAddCheckpoint(Buffer.concat(chunks).toString('utf8'), { logs, latest: (origin) => latest.get(origin) ?? null, witness });
        if (answer.record) remember(answer.record);
      } catch (err) {
        log(`could not answer: ${err.message}`);
        return send(res, 500, 'the witness could not keep its record\n');
      }
      if (answer.status === 422) log('a checkpoint signed by a log it watches does not follow from the one cosigned before: that log is to be looked into');
      send(res, answer.status, answer.body, answer.type);
    });
  });

  let url = null;
  return {
    name,
    verifier,
    get url() {
      return url;
    },
    /** What it cosigned last for a log, for tests and for whoever runs it. */
    latest: (origin) => latest.get(origin) ?? null,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, resolve);
      });
      url = `http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${server.address().port}`;
      log(`listening on ${url} as ${verifier}`);
      for (const origin of logs.keys()) log(`watching ${origin}`);
      return this;
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
