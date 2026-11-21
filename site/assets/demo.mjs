// SPDX-License-Identifier: Apache-2.0
// The demo at the top of the landing page: a signed event the visitor can change, playing the hub,
// and the verdict of the same check every LUCID client makes (verify.mjs), run in the browser.
// What it says comes from the page (the data-* attributes of #stamp and #verdict), so one script
// serves every language.

import { canVerify, verifyEvent } from './verify.mjs';
import { demoEnvelope } from './fixtures.mjs';

const $ = (id) => document.getElementById(id);
const field = $('event');
const stamp = $('stamp');
const verdict = $('verdict');
const original = JSON.stringify(demoEnvelope.event, null, 2);
const shortened = (text, head, tail) => (text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text);

let supported = false;
let turn = 0; // the check under way: an older one that ends late says nothing
let shown = null;

/** The field as tall as what is in it: the whole event is seen, and nothing scrolls inside the page. */
function fit() {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight + 2}px`;
}

function show(state) {
  if (state === shown) return;
  shown = state;
  stamp.dataset.state = state;
  stamp.textContent = stamp.dataset[state];
  verdict.textContent = verdict.dataset[state] ?? '';
  // The stamp comes down again each time the verdict changes: that is what the visitor caused.
  stamp.classList.remove('pressed');
  void stamp.offsetWidth;
  stamp.classList.add('pressed');
}

async function check() {
  fit();
  const mine = ++turn;
  if (!supported) return show('unsupported');
  let event;
  try {
    event = JSON.parse(field.value);
  } catch {
    return show('notjson');
  }
  const result = await verifyEvent({ event, proof: demoEnvelope.proof });
  if (mine !== turn) return;
  show(result.ok ? 'valid' : result.reason === 'forged' ? 'forged' : 'notjson');
}

/** What the visitor has in the field, as an event with data, or the original if it is not one. */
function current() {
  try {
    const event = JSON.parse(field.value);
    if (event && typeof event === 'object' && event.data && typeof event.data === 'object') return event;
  } catch {
    /* not JSON: start again from the event as it was signed */
  }
  return JSON.parse(original);
}

$('signer').textContent = demoEnvelope.proof.key_id;
$('signature').textContent = shortened(demoEnvelope.proof.signature, 24, 8);
$('signature').title = demoEnvelope.proof.signature;
field.value = original;
field.addEventListener('input', check);
addEventListener('resize', fit);
$('tamper').addEventListener('click', () => {
  const event = current();
  event.data.pr = (Number.isInteger(event.data.pr) ? event.data.pr : 42) + 1;
  field.value = JSON.stringify(event, null, 2);
  check();
});
$('reset').addEventListener('click', () => {
  field.value = original;
  check();
});
supported = await canVerify();
check();
