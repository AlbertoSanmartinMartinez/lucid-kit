// SPDX-License-Identifier: Apache-2.0
// The landing page (site/). Its demo checks a signed event in the browser with a check written again
// without Node (site/assets/verify.mjs): it has to say what the core says, for the event it shows and
// for every way a visitor can change it. What the page shows as protocol bytes has to be real: the
// event is signed by its agent and the checkpoint by its hub and a witness. And the two languages
// have to be the same page.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize as coreCanonicalize } from '../src/core/jcs.mjs';
import { generateIdentity, publicKeyBytesFromDid } from '../src/core/didkey.mjs';
import { CONTEXT, createProof, signEvent, verifyEventEnvelope } from '../src/core/sign.mjs';
import { checkSignatures, NOTE_ED25519, noteKeyId, parseCheckpoint, parseNote, parseVerifier } from '../src/core/note.mjs';
import { canonicalize, canVerify, EVENT_CONTEXT, publicKeyOfDid, verifyEvent } from '../site/assets/verify.mjs';
import { checkpointNote, demoEnvelope, witnessVerifier } from '../site/assets/fixtures.mjs';
import { marks, renderArt, TONES } from '../site/tools/art.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PAGES = { en: 'index.html', es: 'es/index.html' };
const read = (page) => readFileSync(join(SITE, page), 'utf8');
const copy = (value) => structuredClone(value);

/** What the core says of an envelope, and what the page says: they must be the same. */
async function both(envelope) {
  const core = verifyEventEnvelope(envelope);
  const page = await verifyEvent(envelope);
  return [core.ok, page.ok];
}

test('the page checks a signature the way the core does', async () => {
  assert.equal(EVENT_CONTEXT, CONTEXT.EVENT);
  assert.equal(await canVerify(), true, 'this runtime checks Ed25519 with WebCrypto, as browsers do');
  assert.deepEqual(await both(demoEnvelope), [true, true]);
  assert.deepEqual(await verifyEvent(demoEnvelope), { ok: true, did: demoEnvelope.event.source });

  // What a visitor playing the hub can do to the event, and what each of the two says of it.
  const changed = (change) => {
    const envelope = copy(demoEnvelope);
    change(envelope.event);
    return envelope;
  };
  const forged = [
    (event) => (event.data.pr = 43),
    (event) => (event.data.repo = 'https://github.com/evil/parser'),
    (event) => (event.time = '2026-01-01T00:00:00.000Z'),
    (event) => (event.subject = 'dev.rust.other'),
    (event) => (event.extra = true),
    (event) => delete event.dataschema,
    (event) => (event.data = { pr: 42, repo: 'https://github.com/acme/parser', more: null }),
  ];
  for (const change of forged) {
    assert.deepEqual(await both(changed(change)), [false, false], String(change));
    assert.equal((await verifyEvent(changed(change))).reason, 'forged');
  }
  // Another sender is another key: the signature is not of it.
  const someone = generateIdentity();
  assert.deepEqual(await both(changed((event) => (event.source = someone.did))), [false, false]);
  // The order of the keys, and how a number is written, are not what is signed: the canonical form is.
  const reordered = copy(demoEnvelope);
  reordered.event = Object.fromEntries(Object.entries(reordered.event).reverse());
  reordered.event.data = { pr: 42, repo: reordered.event.data.repo };
  assert.deepEqual(await both(reordered), [true, true]);
  assert.deepEqual(await both(JSON.parse(JSON.stringify(demoEnvelope).replace('"pr":42', '"pr":42.0'))), [true, true]);
});

test('the page takes no signature for what it is not', async () => {
  // A good signature by one key over an event that says it is from another.
  const signer = generateIdentity();
  const claimed = generateIdentity();
  const event = { ...copy(demoEnvelope.event), source: claimed.did };
  const lent = { event, proof: createProof(CONTEXT.EVENT, event, signer) };
  assert.deepEqual(await both(lent), [false, false]);
  assert.equal((await verifyEvent(lent)).reason, 'forged');
  // A signature made in another context: a card, say, signed over the same bytes.
  const elsewhere = { event: copy(demoEnvelope.event), proof: createProof(CONTEXT.CARD, demoEnvelope.event, generateIdentity()) };
  assert.deepEqual(await both(elsewhere), [false, false]);
  // Proofs that are no proofs, and envelopes that are no envelopes.
  const proof = demoEnvelope.proof;
  const broken = [
    { ...proof, algorithm: 'RS256' },
    { ...proof, canonicalization: 'none' },
    { ...proof, signature: proof.signature.slice(1) },
    { ...proof, signature: `${proof.signature[0] === 'A' ? 'B' : 'A'}${proof.signature.slice(1)}` },
    { ...proof, key_id: 'did:web:acme.example' },
    { ...proof, key_id: 'did:key:z6Mk' },
  ];
  for (const bad of broken) assert.deepEqual(await both({ event: copy(demoEnvelope.event), proof: bad }), [false, false], JSON.stringify(bad).slice(0, 80));
  for (const bad of [null, 'event', [], {}, { event: demoEnvelope.event }, { event: [], proof }, { event: 42, proof }]) {
    assert.equal((await verifyEvent(bad)).ok, false, JSON.stringify(bad)?.slice(0, 60));
  }
  // An event the core signs today is one the page checks, whoever signs it.
  const fresh = generateIdentity();
  assert.deepEqual(await both(signEvent({ ...copy(demoEnvelope.event), source: fresh.did, id: 'another' }, fresh)), [true, true]);
});

test('the canonical form and the key of a did:key are the same as the core makes them', () => {
  const values = [
    { b: 1, a: [true, false, null], 'é': 'x', A: { z: 1, y: [1, { d: 2, c: 3 }] } },
    { '€': 1, '\r': 2, 'דּ': 3, '1': 4, '😀': 5, '\u0080': 6, 'ö': 7 },
    [1e21, 1e-7, 0.1 + 0.2, -0, 123456789012345680000, 5e-324, 'quote " and \\ and \n and  '],
    'plain',
    42,
    null,
  ];
  for (const value of values) assert.equal(canonicalize(value), coreCanonicalize(value));
  assert.throws(() => canonicalize({ x: Infinity }), TypeError);
  assert.throws(() => canonicalize({ x: undefined }), TypeError);
  for (let i = 0; i < 20; i++) {
    const { did } = generateIdentity();
    assert.deepEqual(Buffer.from(publicKeyOfDid(did)), publicKeyBytesFromDid(did));
  }
  for (const bad of ['did:web:acme.example', 'did:key:', 'did:key:z0OIl', 'did:key:zQ3sh', 42, null]) assert.throws(() => publicKeyOfDid(bad), TypeError, String(bad));
});

test('what the page shows as protocol bytes is real', () => {
  // The event, signed by the agent it says it is from.
  assert.equal(verifyEventEnvelope(demoEnvelope).ok, true);
  assert.equal(demoEnvelope.proof.key_id, demoEnvelope.event.source);
  // The checkpoint: of the log of a hub, signed by that hub, and cosigned by the witness it names.
  const { text, signatures } = parseNote(checkpointNote);
  const checkpoint = parseCheckpoint(text);
  const key = publicKeyBytesFromDid(checkpoint.origin);
  const log = { name: checkpoint.origin, type: NOTE_ED25519, key, id: noteKeyId(checkpoint.origin, NOTE_ED25519, key) };
  const seen = checkSignatures(text, signatures, { log, witnesses: [parseVerifier(witnessVerifier)] });
  assert.equal(seen.byLog, true);
  assert.deepEqual(
    seen.cosigned.map(({ name }) => name),
    ['witness.example/w1'],
  );
  assert.ok(checkpoint.size > 0);
  // And it is the one both pages show, as text.
  const unescape = (html) => html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const page of Object.values(PAGES)) {
    const shown = /<!-- checkpoint -->([\s\S]*?)<!-- \/checkpoint -->/.exec(read(page))?.[1];
    assert.equal(unescape(shown ?? ''), checkpointNote, page);
  }
});

test('the two languages are the same page', () => {
  const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
  const dataOf = (html, id) => {
    const tag = new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`, 's').exec(html)?.[0] ?? '';
    return Object.fromEntries([...tag.matchAll(/\sdata-([a-z]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
  };
  const en = read(PAGES.en);
  const es = read(PAGES.es);
  assert.deepEqual(ids(es), ids(en));
  assert.match(en, /<html lang="en">/);
  assert.match(es, /<html lang="es">/);
  // Every state of the demo has its words in both.
  const states = ['checking', 'valid', 'forged', 'notjson', 'unsupported'];
  for (const html of [en, es]) {
    const stamp = dataOf(html, 'stamp');
    const verdict = dataOf(html, 'verdict');
    for (const state of states) assert.ok(stamp[state], `stamp: ${state}`);
    for (const state of states.slice(1)) assert.ok(verdict[state], `verdict: ${state}`);
  }
  // Every element the script looks for is on both pages.
  const wanted = [...readFileSync(join(SITE, 'assets/demo.mjs'), 'utf8').matchAll(/\$\('([^']+)'\)/g)].map(([, id]) => id);
  assert.ok(wanted.length >= 6);
  for (const id of wanted) for (const html of [en, es]) assert.ok(ids(html).includes(id), id);
  // Each links to the other, and what each page loads from the site is there.
  assert.match(en, /href="es\/" hreflang="es"/);
  assert.match(es, /href="\.\.\/" hreflang="en"/);
  for (const [lang, page] of Object.entries(PAGES)) {
    const html = read(page);
    const local = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map(([, path]) => path).filter((path) => !path.includes(':') && !path.startsWith('#') && !path.endsWith('/'));
    assert.ok(local.length >= 4, lang);
    for (const path of local) assert.ok(existsSync(join(SITE, dirname(page), path)), `${page}: ${path}`);
  }
  // No id twice on a page: the drawings carry ids of their own (their clips, masks and gradients).
  for (const html of [en, es]) {
    const all = ids(html);
    assert.deepEqual(all.filter((id, at) => all.indexOf(id) !== at), []);
  }
  // And what the stylesheet loads, too.
  for (const [, path] of readFileSync(join(SITE, 'assets/lucid.css'), 'utf8').matchAll(/url\('([^']+)'\)/g)) assert.ok(existsSync(join(SITE, 'assets', path)), path);
});

test('the drawings on both pages are the ones the drawing tool makes', () => {
  const art = renderArt();
  assert.deepEqual(Object.keys(art), ['scene', 'L', 'U', 'C', 'I', 'D']);
  for (const page of Object.values(PAGES)) {
    const html = read(page);
    for (const [name, drawing] of Object.entries(art)) {
      const shown = marks(name).exec(html)?.[0];
      assert.equal(shown, `<!-- art:${name} -->${drawing}<!-- /art:${name} -->`, `${page}: ${name} (run node site/tools/art.mjs)`);
    }
  }
  // Each one says nothing in any language, hides itself from screen readers, and can be held still.
  for (const [name, drawing] of Object.entries(art)) {
    assert.match(drawing, /^<svg class="art [^"]+" viewBox="[-\d. ]+" data-still="[\d.]+" focusable="false" aria-hidden="true"/, name);
    assert.doesNotMatch(drawing, /<text[^>]*>[^<]{2,}<\/text>/, `${name} has words in it`);
    assert.doesNotMatch(drawing, /NaN|undefined/, name);
  }
  // The ink of each letter is the same in the drawings and in the stylesheet.
  const css = readFileSync(join(SITE, 'assets/lucid.css'), 'utf8');
  const inks = { L: 'log', U: 'sign', C: 'crypt', I: 'bridge', D: 'find' };
  for (const [letter, tone] of Object.entries(TONES)) assert.match(css, new RegExp(`--${inks[letter]}: ${tone};`), letter);
});

test('each page says its address and the address of the other language', () => {
  const head = (page) => read(page).slice(0, read(page).indexOf('</head>'));
  const alternates = (html) => [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)" \/>/g)].map(([, lang, href]) => `${lang} ${href}`);
  for (const [lang, page] of Object.entries(PAGES)) {
    const html = head(page);
    const address = lang === 'en' ? 'https://uselucid.org/' : `https://uselucid.org/${lang}/`;
    assert.match(html, new RegExp(`<link rel="canonical" href="${address}" />`), lang);
    assert.match(html, new RegExp(`<meta property="og:url" content="${address}" />`), lang);
    assert.deepEqual(alternates(html), ['en https://uselucid.org/', 'es https://uselucid.org/es/', 'x-default https://uselucid.org/'], lang);
  }
  // The contact address is a real one now, the same on both pages.
  for (const page of Object.values(PAGES)) assert.deepEqual([...read(page).matchAll(/mailto:([^"]+)"/g)].map(([, address]) => address), ['info@albertosanmartinmartinez.es', 'info@albertosanmartinmartinez.es']);
});
