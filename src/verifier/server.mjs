// SPDX-License-Identifier: AGPL-3.0-only
// The verifier: a small service that signs account attestations (core/attestation.mjs).
//
// A controller asks it, with a request signed by its key (POST /v1/verifications). The verifier asks
// the provider - GitHub, by its device flow - for a code, and gives it to the controller, whose person
// types it at the provider and says yes. The controller then asks how it went (GET /v1/verifications/:id),
// and the verifier, once the provider says who signed in, signs that the controller key is that account.
// The controller hands the attestation to whichever hubs it likes; a hub takes it if its operator
// trusts this verifier's key.
//
// What it keeps: its key, on disk, and the verifications under way, in memory and for 15 minutes at
// most. It keeps no token of the provider: each is used once, to read who signed in, and dropped.
//
// What it does not stop: a person who types, on GitHub, a code that somebody else sent them links their
// account to that somebody's key. GitHub shows which app is asking before saying yes; it is the same
// with any device flow.

import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountReference, createAttestation, verifyVerificationRequest } from '../core/attestation.mjs';
import { originOf } from '../core/reqsig.mjs';
import { loadOrCreateHubIdentity } from '../hub/federation.mjs';
import { RateLimiter } from '../hub/ratelimit.mjs';

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
const MAX_BODY = 8192;
const MAX_UNDER_WAY = 10_000;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The secret under which this verifier turns accounts into the references its attestations carry
 * (core/attestation.mjs): kept with its data, created the first time. The console of the service needs
 * the same one to know which controllers are whose. Losing it means new references for everybody.
 */
export function loadOrCreateReferenceSecret(dataDir) {
  if (!dataDir) return randomBytes(32);
  const file = join(dataDir, 'verifier-reference-secret');
  if (existsSync(file)) {
    const secret = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
    if (secret.length < 32) throw new Error(`the secret in ${file} is damaged`);
    return secret;
  }
  const secret = randomBytes(32);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, `${secret.toString('base64url')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return secret;
}

export function createVerifier({ provider, port = 8788, host = '127.0.0.1', dataDir = null, identity = null, referenceSecret = null, publicUrl = null, trustProxy = 0, attestationDays = 30, quiet = false, log = null, limits = {} }) {
  if (!provider) throw new Error('a verifier needs a provider to sign in with');
  if (publicUrl == null && !LOOPBACK.includes(host)) throw new Error('a verifier reachable from other machines needs the address it is reached at (publicUrl): requests are signed for it');
  if (publicUrl != null && originOf(publicUrl) === null) throw new Error('publicUrl must be an http(s) address');
  const say = log ?? (quiet ? () => {} : (line) => console.log(`[verifier] ${line}`));
  const key = identity ?? loadOrCreateHubIdentity(dataDir, 'verifier-identity.json');
  const secret = referenceSecret ?? loadOrCreateReferenceSecret(dataDir);
  const limiter = new RateLimiter();
  const rate = { start: { burst: 10, perMinute: 10 }, poll: { burst: 120, perMinute: 120 }, ...limits }; // per IP
  const underWay = new Map(); // id -> { controller, deviceCode, userCode, verificationUri, expiresAt, interval, nextPollAt, polling, outcome }
  const nonces = new Map(); // nonce -> when it can be forgotten
  let address = publicUrl;
  let server;

  const origins = () => {
    const found = new Set([originOf(address)].filter(Boolean));
    const listening = server?.address()?.port;
    if (publicUrl == null && listening) for (const name of ['127.0.0.1', 'localhost', '[::1]']) found.add(originOf(`http://${name}:${listening}`));
    return [...found];
  };
  const forgetOld = (now) => {
    for (const [id, verification] of underWay) if (verification.expiresAt + 15 * 60_000 < now) underWay.delete(id);
    for (const [nonce, until] of nonces) if (until < now) nonces.delete(nonce);
  };
  const view = (id, verification) => {
    // Which account it was is said to whoever asked, so that they can see it is theirs; it is in no attestation.
    if (verification.outcome?.attestation) return { id, status: 'verified', attestation: verification.outcome.attestation, account: verification.outcome.account, name: verification.outcome.name };
    if (verification.outcome?.failed) return { id, status: 'failed', reason: verification.outcome.failed };
    return { id, status: 'pending', user_code: verification.userCode, verification_uri: verification.verificationUri, expires_at: new Date(verification.expiresAt).toISOString(), interval: verification.interval };
  };

  /** Asks the provider how a verification goes, at most as often as it allows and one question at a time. */
  const advance = async (verification, now) => {
    if (verification.outcome) return;
    if (now > verification.expiresAt) {
      verification.outcome = { failed: 'the code ran out before anybody typed it' };
      return;
    }
    if (now < verification.nextPollAt) return;
    verification.polling ??= (async () => {
      try {
        const answer = await provider.poll(verification.deviceCode);
        if (answer.slowDown) verification.interval += 5; // what the device flow asks for
        if (answer.failed) verification.outcome = { failed: answer.failed };
        if (answer.account) {
          const attestation = createAttestation(key, { controller: verification.controller, account: accountReference(secret, answer.account), days: attestationDays });
          verification.outcome = { attestation, account: answer.account, name: answer.name };
          say(`${verification.controller} is an account of ${provider.name}: attested`);
        }
      } catch {
        // The provider did not answer: it is asked again next time.
      } finally {
        verification.nextPollAt = Date.now() + verification.interval * 1000;
        verification.polling = null;
      }
    })();
    await verification.polling;
  };

  const routes = {
    'GET /healthz': () => ({ body: { ok: true } }),

    'GET /v1/info': () => ({ body: { name: 'agenthub-verifier', verifier: key.did, provider: provider.name, attestation_days: attestationDays, origins: origins() } }),

    'POST /v1/verifications': async (ctx) => {
      if (!limiter.take(`start:${ctx.ip}`, rate.start)) throw new HttpError(429, 'rate_limited', 'too many requests, slow down');
      const now = Date.now();
      forgetOld(now);
      const verdict = verifyVerificationRequest(ctx.json(), { origins: origins(), now });
      if (!verdict.ok) throw new HttpError(verdict.wrongVerifier ? 401 : 400, verdict.wrongVerifier ? 'wrong_verifier' : 'invalid_request', `request rejected: ${verdict.error}`);
      if (nonces.has(verdict.nonce)) throw new HttpError(409, 'replayed_request', 'this request was already made');
      if (underWay.size >= MAX_UNDER_WAY) throw new HttpError(503, 'busy', 'too many verifications under way: try again in a while');
      nonces.set(verdict.nonce, now + 15 * 60_000);
      let started;
      try {
        started = await provider.start();
      } catch {
        throw new HttpError(502, 'provider_unreachable', `${provider.name} did not answer: try again in a while`);
      }
      const id = randomBytes(16).toString('base64url');
      const verification = {
        controller: verdict.controller,
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        expiresAt: now + started.expiresIn * 1000,
        interval: started.interval,
        nextPollAt: now + started.interval * 1000,
        polling: null,
        outcome: null,
      };
      underWay.set(id, verification);
      return { status: 201, body: view(id, verification) };
    },

    'GET /v1/verifications/:id': async (ctx) => {
      if (!limiter.take(`poll:${ctx.ip}`, rate.poll)) throw new HttpError(429, 'rate_limited', 'too many requests, slow down');
      const verification = ID_RE.test(ctx.id) ? underWay.get(ctx.id) : undefined;
      if (!verification) throw new HttpError(404, 'not_found', 'there is no such verification, or it was forgotten');
      await advance(verification, Date.now());
      return { body: view(ctx.id, verification) };
    },
  };

  /** Behind `trustProxy` reverse proxies, the client is that many entries from the end of X-Forwarded-For: its limits are per client, not per proxy. */
  const clientIp = (req) => {
    if (trustProxy > 0) {
      const chain = String(req.headers['x-forwarded-for'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
      const candidate = chain[chain.length - trustProxy];
      if (candidate && isIP(candidate)) return candidate;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const handle = async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, 'http://verifier.invalid');
      const match = /^\/v1\/verifications\/([^/]+)$/.exec(url.pathname);
      const route = routes[`${req.method} ${match ? '/v1/verifications/:id' : url.pathname}`];
      if (!route) throw new HttpError(404, 'not_found', 'no such endpoint');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'request body too large');
        chunks.push(chunk);
      }
      const ctx = {
        ip: clientIp(req),
        id: match?.[1] ?? null,
        json: () => {
          try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            throw new HttpError(400, 'invalid_json', 'the body is not JSON');
          }
        },
      };
      const { status = 200, body } = await route(ctx);
      send(status, body);
    } catch (err) {
      if (err instanceof HttpError) send(err.status, { error: { code: err.code, message: err.message } });
      else {
        say(`error: ${err.message}`);
        send(500, { error: { code: 'internal', message: 'internal error' } });
      }
    }
  };

  server = createServer((req, res) => {
    handle(req, res);
  });
  return {
    did: key.did,
    get url() {
      return address;
    },
    get port() {
      return server.address()?.port ?? null;
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      address ??= `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
      say(`listening on ${address}, signing in with ${provider.name}; hubs that take what it signs name it with --trust-verifier ${key.did}`);
      return this;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
