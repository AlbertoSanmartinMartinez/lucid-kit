// SPDX-License-Identifier: Apache-2.0
// did:web resolution, for organizations that anchor their identity in a domain.
//
//   did:web:acme.com              -> https://acme.com/.well-known/did.json
//   did:web:acme.com:teams:infra  -> https://acme.com/teams/infra/did.json
//
// Whoever controls the domain controls the document, and the document lists
// the keys allowed to sign on the organization's behalf. Resolving it means
// the hub fetches a URL chosen by a client, so the fetch is locked down:
// HTTPS only, DNS names only, every resolved address must be public (checked
// on the very lookup the connection uses, so DNS rebinding cannot slip a
// private address in), no redirects, a hard timeout and a size cap.

import dns from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { base58Decode } from './didkey.mjs';

const DID_WEB_RE = /^did:web:([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10})(?:%3A(\d{1,5}))?((?::[A-Za-z0-9._~-]{1,64}){0,8})$/;
const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.test', '.invalid', '.example', '.onion'];

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isDidWeb(did) {
  try {
    parseDidWeb(did);
    return true;
  } catch {
    return false;
  }
}

/** Splits a did:web into { did, host, port, path } or throws. Only public-looking DNS names are accepted. */
export function parseDidWeb(did) {
  const match = typeof did === 'string' && did.length <= 300 ? DID_WEB_RE.exec(did) : null;
  if (!match) throw new Error('not a valid did:web');
  const [, host, port, rawPath] = match;
  const labels = host.split('.');
  if (labels.some((label) => label.startsWith('-') || label.endsWith('-'))) throw new Error('not a valid did:web');
  if (/^\d+$/.test(labels.at(-1))) throw new Error('did:web must use a domain name, not an IP address');
  if (INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new Error('did:web host is not a public domain');
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw new Error('not a valid did:web');
  const path = rawPath ? rawPath.slice(1).split(':') : [];
  if (path.some((segment) => segment === '.' || segment === '..')) throw new Error('not a valid did:web');
  return { did, host, port: port === undefined ? null : Number(port), path };
}

export function didWebUrl(did) {
  const { host, port, path } = parseDidWeb(did);
  const location = path.length > 0 ? path.join('/') : '.well-known';
  return `https://${host}${port === null ? '' : `:${port}`}/${location}/did.json`;
}

// --- reading the document ---------------------------------------------------------

function rawEd25519(method) {
  try {
    if (typeof method.publicKeyMultibase === 'string' && method.publicKeyMultibase.startsWith('z')) {
      const decoded = base58Decode(method.publicKeyMultibase.slice(1));
      if (decoded.length === 34 && decoded[0] === 0xed && decoded[1] === 0x01) return decoded.subarray(2);
    }
    const jwk = method.publicKeyJwk;
    if (isPlainObject(jwk) && jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && typeof jwk.x === 'string') {
      const raw = Buffer.from(jwk.x, 'base64url');
      if (raw.length === 32) return raw;
    }
  } catch {
    /* not a key we understand */
  }
  return null;
}

/**
 * Returns Map<key id, raw Ed25519 public key> with the keys the document authorizes
 * for assertions (signing statements such as delegations). Throws if the document
 * is not the one for `did`.
 */
export function documentKeys(document, did) {
  if (!isPlainObject(document) || document.id !== did) throw new Error('DID document does not describe this DID');
  const absolute = (id) => (typeof id === 'string' ? (id.startsWith('#') ? did + id : id) : null);
  const declared = new Map();
  for (const method of Array.isArray(document.verificationMethod) ? document.verificationMethod : []) {
    if (isPlainObject(method) && absolute(method.id)) declared.set(absolute(method.id), method);
  }
  const keys = new Map();
  for (const entry of Array.isArray(document.assertionMethod) ? document.assertionMethod : []) {
    const method = typeof entry === 'string' ? declared.get(absolute(entry)) : entry;
    const id = isPlainObject(method) ? absolute(method.id) : null;
    if (!id || !id.startsWith(`${did}#`)) continue; // keys of other DIDs do not speak for this one
    if (method.controller !== undefined && method.controller !== did) continue;
    const raw = rawEd25519(method);
    if (raw) keys.set(id, raw);
  }
  return keys;
}

/** The document an organization publishes so that `controllerDidKey` can sign as `did`. */
export function didWebDocument(did, controllerDidKey, keyId = 'key-1') {
  parseDidWeb(did);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error('key id must be 1-64 characters: letters, digits, ".", "_" or "-"');
  if (typeof controllerDidKey !== 'string' || !controllerDidKey.startsWith('did:key:z')) throw new Error('the controller must be a did:key');
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [
      { id: `${did}#${keyId}`, type: 'Multikey', controller: did, publicKeyMultibase: controllerDidKey.slice('did:key:'.length) },
    ],
    assertionMethod: [`${did}#${keyId}`],
  };
}

// --- fetching it safely -----------------------------------------------------------

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 127], // :: and ::1
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64
  ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], // discard, Teredo, documentation, 6to4
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], // unique local, link local, multicast
]) blocked.addSubnet(network, prefix, 'ipv6');

/** True only for addresses routable on the public internet. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !blocked.check(address, 'ipv4');
  // An IPv4-mapped address (::ffff:a.b.c.d) is only as public as the IPv4 address inside it.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  if (/^::ffff:/i.test(address)) return false; // mapped, but in a form we do not parse
  return !blocked.check(address, 'ipv6');
}

function publicOnlyLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, family: options?.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err);
    if (addresses.length === 0 || !addresses.every((entry) => isPublicAddress(entry.address))) {
      return callback(new Error('host resolves to a non-public address'));
    }
    return options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
  });
}

function fetchDidDocument(url, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    const req = https.request(
      url,
      { method: 'GET', lookup: publicOnlyLookup, agent: false, headers: { accept: 'application/did+json, application/json', 'user-agent': 'agent-hub' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(reject, new Error(`the server answered ${res.statusCode}`)); // redirects are not followed
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) req.destroy(new Error('document is too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            finish(resolve, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
          } catch {
            finish(reject, new Error('document is not valid JSON'));
          }
        });
        res.on('error', (err) => finish(reject, err));
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
    req.on('error', (err) => finish(reject, err));
    req.end();
  });
}

/**
 * Returns `resolve(did) -> { did, url, keys }`, caching results (and failures, briefly).
 * `fetchDocument` can be replaced, which is how tests stand in for the network.
 */
export function createDidWebResolver({ timeoutMs = 5000, maxBytes = 64 * 1024, cacheMs = 5 * 60_000, fetchDocument = fetchDidDocument, now = Date.now } = {}) {
  const cache = new Map();
  return async function resolveDidWeb(did) {
    const url = didWebUrl(did); // validates the DID
    const hit = cache.get(did);
    if (hit && hit.expires > now()) {
      if (hit.error) throw hit.error;
      return hit.value;
    }
    if (cache.size > 1000) cache.clear();
    try {
      const value = { did, url, keys: documentKeys(await fetchDocument(url, { timeoutMs, maxBytes }), did) };
      cache.set(did, { value, expires: now() + cacheMs });
      return value;
    } catch (cause) {
      const error = new Error(`cannot resolve ${did}: ${cause.message}`);
      cache.set(did, { error, expires: now() + Math.min(cacheMs, 30_000) });
      throw error;
    }
  };
}
