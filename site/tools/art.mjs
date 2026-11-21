// SPDX-License-Identifier: Apache-2.0
// Draws the isometric illustrations of the landing page as inline SVG, and puts them into both pages
// between their <!-- art:NAME --> and <!-- /art:NAME --> marks: the scene of the hero, and a vignette
// for each letter of the name. The geometry is worked out here, so that every face meets the next;
// the pages carry what this writes, and test/site.test.mjs checks that they still do.
//
// The scene: two hubs, each with its agents; messages, sealed and signed, travel from an agent of one
// to an agent of the other across a bridge; beside the first hub its log grows one entry at a time,
// and a witness standing apart cosigns each new head. Each part is drawn in the ink of its letter:
//   L, the log and its witness  U, the agents and their seals  C, the lock on each message
//   I, the bridge between hubs  D, the directory
// Nothing in the drawings is in any language: what they show is said in the pages, around them.
//
// The motion is SMIL, so that a page can pause it (svg.pauseAnimations) when it is not on screen and
// hold a still frame (data-still, in seconds) for whoever asks their system for less motion
// (site/assets/motion.mjs). Every loop ends where it began: nothing jumps.
//
// Usage: node site/tools/art.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TONES = { L: '#0f7b6c', U: '#5536b8', C: '#0d6aad', I: '#9e6c00', D: '#c4144f' };
const INK = '#241f3d';
const PAPER = '#ffffff';
const HUB = { top: '#efecf8', left: '#dcd6ee', right: '#c7bfe1', edge: '#a99fcd' };
const GRID = '#e4e2ec';

const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const mix = (a, b, t) =>
  `#${rgb(a)
    .map((v, i) => Math.round(v + (rgb(b)[i] - v) * t).toString(16).padStart(2, '0'))
    .join('')}`;
/** The faces of a solid in one ink: lit from above and from the left. */
const ramp = (tone) => ({ top: mix(tone, '#ffffff', 0.42), left: mix(tone, '#ffffff', 0.08), right: mix(tone, '#000000', 0.18), edge: mix(tone, '#000000', 0.34) });
const RAMP = Object.fromEntries(Object.entries(TONES).map(([letter, tone]) => [letter, ramp(tone)]));

const num = (value) => Number(value.toFixed(1));
const COS = Math.cos(Math.PI / 6);

/** The isometric projection: x goes right and down, y left and down, z up. `s` is the size of a unit, in pixels. */
function projection(s, ox, oy) {
  return (x, y, z = 0) => [num(ox + (x - y) * COS * s), num(oy + (x + y) * 0.5 * s - z * s)];
}
const pts = (list) => list.map(([x, y]) => `${x},${y}`).join(' ');
const polygon = (list, fill, edge) => `<polygon points="${pts(list)}" fill="${fill}"${edge ? ` stroke="${edge}" stroke-width="0.7" stroke-linejoin="round"` : ''}/>`;

/** A box from (x, y, z), w by d by h, with the faces a viewer from above and in front sees. */
function box(P, { x, y, z = 0, w, d, h }, faces) {
  const [x1, y1, z1] = [x + w, y + d, z + h];
  return [
    polygon([P(x1, y, z), P(x1, y1, z), P(x1, y1, z1), P(x1, y, z1)], faces.right, faces.edge),
    polygon([P(x, y1, z), P(x1, y1, z), P(x1, y1, z1), P(x, y1, z1)], faces.left, faces.edge),
    polygon([P(x, y, z1), P(x1, y, z1), P(x1, y1, z1), P(x, y1, z1)], faces.top, faces.edge),
  ].join('');
}

/** The SMIL attributes of a loop of `dur` seconds that starts `begin` seconds in. */
const loop = (dur, begin = 0) => `dur="${dur}s" begin="${begin}s" repeatCount="indefinite"`;

/** A message: an envelope sealed by its sender (U) and locked for its reader (C), drawn around (0, 0). */
function envelope(scale = 1) {
  return (
    `<g transform="scale(${scale})">` +
    `<rect x="-12" y="-8" width="24" height="16" rx="2.2" fill="${PAPER}" stroke="${INK}" stroke-width="1.3"/>` +
    `<polyline points="-12,-8 0,1.5 12,-8" fill="none" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/>` +
    `<circle cx="0" cy="3.4" r="3.6" fill="${TONES.U}"/>` +
    `<path d="M7.6,-11.2 v-2.4 a2.6,2.6 0 0 1 5.2,0 v2.4" fill="none" stroke="${TONES.C}" stroke-width="1.5"/>` +
    `<rect x="6.2" y="-11.4" width="8" height="6.6" rx="1.4" fill="${TONES.C}"/>` +
    `</g>`
  );
}

/**
 * The log: a stack of entries on a footprint, which grows by one each `dur` seconds. A new entry comes
 * down onto the stack, the witness cosigns the new head, and the whole stack sinks by one entry into
 * the ground: the picture the loop ends on is the one it began with.
 */
function logStack(P, { id, x, y, w, d, slab, count, dur }, faces) {
  const top = slab * count;
  const sink = num(P(0, 0, 0)[1] - P(0, 0, -slab)[1]);
  const drop = num(P(0, 0, 0)[1] - P(0, 0, 1.6)[1]);
  const footprint = [P(x, y + d, 0), P(x + w, y + d, 0), P(x + w, y, 0)];
  const clip = [...footprint, [footprint[2][0], footprint[2][1] - 400], [footprint[0][0], footprint[0][1] - 400]];
  let slabs = '';
  for (let i = 0; i < count; i++) slabs += box(P, { x, y, z: i * slab, w, d, h: slab }, faces);
  const newest =
    `<g opacity="0"><animate attributeName="opacity" values="0;1" keyTimes="0;0.3" calcMode="discrete" ${loop(dur)}/>` +
    `<animateTransform attributeName="transform" type="translate" values="0 ${-drop};0 ${-drop};0 0;0 0" keyTimes="0;0.3;0.5;1" ${loop(dur)}/>` +
    box(P, { x, y, z: top, w, d, h: slab }, faces) +
    `</g>`;
  return {
    defs: `<clipPath id="${id}-ground" clipPathUnits="userSpaceOnUse"><polygon points="${pts(clip)}"/></clipPath>`,
    body:
      `<g clip-path="url(#${id}-ground)"><g>` +
      `<animateTransform attributeName="transform" type="translate" values="0 0;0 0;0 ${sink};0 ${sink}" keyTimes="0;0.72;0.95;1" ${loop(dur)}/>` +
      slabs +
      newest +
      `</g></g>`,
    head: P(x + w / 2, y + d / 2, top + slab),
  };
}

/** The ring a witness leaves on the head it cosigns, and the line from the witness to it, both on the log's beat. */
function cosign(head, from, dur, { rx = 18, ry = 10 } = {}) {
  const beat = `keyTimes="0;0.5;0.56;0.72;1" ${loop(dur)}`;
  return (
    `<line x1="${from[0]}" y1="${from[1]}" x2="${head[0]}" y2="${head[1]}" stroke="${TONES.L}" stroke-width="1.4" stroke-dasharray="3 4" stroke-linecap="round" opacity="0.3">` +
    `<animate attributeName="opacity" values="0.3;0.3;1;0.3;0.3" ${beat}/></line>` +
    `<ellipse cx="${head[0]}" cy="${head[1]}" rx="${rx * 0.4}" ry="${ry * 0.4}" fill="none" stroke="${RAMP.L.edge}" stroke-width="2" opacity="0">` +
    `<animate attributeName="opacity" values="0;0;1;0;0" ${beat}/>` +
    `<animate attributeName="rx" values="${rx * 0.4};${rx * 0.4};${rx * 0.7};${rx};${rx}" ${beat}/>` +
    `<animate attributeName="ry" values="${ry * 0.4};${ry * 0.4};${ry * 0.7};${ry};${ry}" ${beat}/>` +
    `</ellipse>`
  );
}

/** A letter in its ink, pointing at the part of the drawing it names. */
function callout(letter, at, to) {
  return (
    `<line x1="${at[0]}" y1="${at[1]}" x2="${to[0]}" y2="${to[1]}" stroke="${TONES[letter]}" stroke-width="1.2"/>` +
    `<circle cx="${to[0]}" cy="${to[1]}" r="2.4" fill="${TONES[letter]}"/>` +
    `<circle cx="${at[0]}" cy="${at[1]}" r="13" fill="${TONES[letter]}"/>` +
    `<text x="${at[0]}" y="${num(at[1] + 5.2)}" text-anchor="middle" font-size="15" fill="#ffffff">${letter}</text>`
  );
}

const svg = (name, [x, y, w, h], still, body, defs = '') =>
  `<svg class="art art-${name}" viewBox="${x} ${y} ${w} ${h}" data-still="${still}" focusable="false" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">` +
  (defs ? `<defs>${defs}</defs>` : '') +
  body +
  `</svg>`;

/** A floor of isometric lines, faint, under a drawing, fading out towards its edges. */
function floor(P, id, [x0, x1], [y0, y1], z) {
  let lines = '';
  for (let x = x0; x <= x1; x++) lines += `<line x1="${P(x, y0, z)[0]}" y1="${P(x, y0, z)[1]}" x2="${P(x, y1, z)[0]}" y2="${P(x, y1, z)[1]}"/>`;
  for (let y = y0; y <= y1; y++) lines += `<line x1="${P(x0, y, z)[0]}" y1="${P(x0, y, z)[1]}" x2="${P(x1, y, z)[0]}" y2="${P(x1, y, z)[1]}"/>`;
  const [cx, cy] = P((x0 + x1) / 2, (y0 + y1) / 2, z);
  const reach = num(Math.max(P(x1, y0, z)[0] - cx, P(x1, y1, z)[1] - cy) * 0.82);
  return {
    defs:
      `<radialGradient id="${id}-fade" cx="${cx}" cy="${cy}" r="${reach}" gradientUnits="userSpaceOnUse"><stop offset="0.55" stop-color="#ffffff"/><stop offset="1" stop-color="#000000"/></radialGradient>` +
      `<mask id="${id}-mask" maskUnits="userSpaceOnUse" x="-2000" y="-2000" width="4000" height="4000"><rect x="-2000" y="-2000" width="4000" height="4000" fill="url(#${id}-fade)"/></mask>`,
    body: `<g stroke="${GRID}" stroke-width="1" mask="url(#${id}-mask)">${lines}</g>`,
  };
}

/** An agent: a block in the ink of signatures, with a light on top that shows when it sends. */
function agent(P, at, blink) {
  const light = P(at.x + at.w / 2, at.y + at.d / 2, at.h);
  return (
    box(P, { ...at, z: 0 }, RAMP.U) +
    `<ellipse cx="${light[0]}" cy="${light[1]}" rx="5" ry="2.9" fill="#ffffff" opacity="0.35">` +
    (blink ? `<animate attributeName="opacity" values="0.35;1;0.35;0.35" keyTimes="0;0.06;0.18;1" ${loop(blink.dur, blink.begin)}/>` : '') +
    `</ellipse>`
  );
}

/** The directory: a box of cards, its front card rising now and then, as if looked up. */
function directory(P, { x, y, w, d, h }, dur) {
  let cards = '';
  for (let i = 0; i < 3; i++) {
    const card = box(P, { x: x + 0.2, y: y + 0.25 + i * 0.32, z: h * 0.45, w: w - 0.4, d: 0.12, h: h * 0.85 }, { top: '#ffffff', left: '#ffffff', right: '#f3eef1', edge: RAMP.D.edge });
    cards +=
      i === 1
        ? `<g>${card}<animateTransform attributeName="transform" type="translate" values="0 0;0 0;0 -9;0 -9;0 0;0 0" keyTimes="0;0.4;0.5;0.7;0.8;1" ${loop(dur)}/></g>`
        : card;
  }
  return box(P, { x, y, z: 0, w, d, h: h * 0.6 }, RAMP.D) + cards;
}

/** The scene of the hero. */
function scene() {
  const P = projection(24, 236, 128);
  const DUR = { log: 4.5, message: 7 };
  const hubA = { x: 0, y: 0, w: 7, d: 7 };
  const hubB = { x: 10, y: 0, w: 7, d: 7 };
  const log = logStack(P, { id: 'scene-log', x: 0.8, y: 0.8, w: 1.8, d: 1.8, slab: 0.42, count: 6, dur: DUR.log }, RAMP.L);
  const witnessAt = { x: -3.4, y: 1.4, w: 1.2, d: 1.2 };
  const witnessTop = P(witnessAt.x + 0.6, witnessAt.y + 0.6, 1.5);

  // The two journeys, each from an agent of one hub to an agent of the other, over the bridge.
  const there = [P(5.0, 4.8, 1.9), P(6.4, 3.6, 0.8), P(7, 3.5, 0.75), P(10, 3.5, 0.75), P(10.7, 3.0, 0.8), P(11.8, 1.8, 1.9)];
  const back = [P(13.2, 5.0, 1.9), P(10.7, 3.9, 0.8), P(10, 3.6, 0.75), P(7, 3.6, 0.75), P(6.3, 2.6, 0.8), P(4.2, 1.5, 1.9)];
  const journey = (path, begin) =>
    `<g opacity="0"><animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.06;0.48;0.54;1" ${loop(DUR.message, begin)}/>` +
    `<animateMotion path="M${pts(path).replace(/ /g, ' L')}" keyPoints="0;1;1" keyTimes="0;0.5;1" calcMode="linear" ${loop(DUR.message, begin)}/>` +
    envelope(1.35) +
    `</g>`;

  const bridgeFlow = [P(7, 3.55, 0.02), P(10, 3.55, 0.02)];
  const ground = floor(P, 'scene', [-5, 19], [-3, 10], -0.8);
  const body =
    ground.body +
    // The witness, on its own ground: it is somebody else's.
    box(P, { x: witnessAt.x - 0.3, y: witnessAt.y - 0.3, z: -0.8, w: 1.8, d: 1.8, h: 0.8 }, { top: '#e9f3f1', left: '#d3e7e3', right: '#bcd9d3', edge: '#9cc6be' }) +
    box(P, { ...witnessAt, z: 0, h: 1.5 }, RAMP.L) +
    `<circle cx="${witnessTop[0]}" cy="${num(witnessTop[1] - 9)}" r="5.5" fill="none" stroke="${RAMP.L.edge}" stroke-width="2"/>` +
    `<circle cx="${witnessTop[0]}" cy="${num(witnessTop[1] - 9)}" r="2" fill="${RAMP.L.edge}"/>` +
    box(P, { ...hubA, z: -0.8, h: 0.8 }, HUB) +
    log.body +
    cosign(log.head, [witnessTop[0], witnessTop[1] - 9], DUR.log) +
    agent(P, { x: 3.6, y: 0.9, w: 1.2, d: 1.2, h: 1.2 }, { dur: DUR.message, begin: 3.5 + DUR.message * 0.5 }) +
    agent(P, { x: 4.4, y: 4.2, w: 1.2, d: 1.2, h: 1.2 }, { dur: DUR.message, begin: 0 }) +
    // The bridge between the two hubs, and what flows over it.
    box(P, { x: 7, y: 3, z: -0.4, w: 3, d: 1.1, h: 0.4 }, RAMP.I) +
    `<line x1="${bridgeFlow[0][0]}" y1="${bridgeFlow[0][1]}" x2="${bridgeFlow[1][0]}" y2="${bridgeFlow[1][1]}" stroke="${RAMP.I.edge}" stroke-width="2" stroke-dasharray="4 7" stroke-linecap="round">` +
    `<animate attributeName="stroke-dashoffset" values="0;-22" ${loop(1.6)}/></line>` +
    box(P, { ...hubB, z: -0.8, h: 0.8 }, HUB) +
    agent(P, { x: 11.2, y: 1.2, w: 1.2, d: 1.2, h: 1.2 }, { dur: DUR.message, begin: DUR.message * 0.5 }) +
    directory(P, { x: 14.3, y: 0.9, w: 1.8, d: 1.3, h: 1.1 }, 5) +
    agent(P, { x: 12.6, y: 4.4, w: 1.2, d: 1.2, h: 1.2 }, { dur: DUR.message, begin: 3.5 }) +
    journey(there, 0) +
    journey(back, 3.5) +
    callout('L', P(-1.2, -1.0, 3.3), P(1.2, 0.9, 2.9)) +
    callout('U', P(3.0, 4.6, 3.6), P(4.8, 4.7, 1.25)) +
    callout('C', P(6.6, 1.0, 3.2), P(6.6, 3.0, 1.3)) +
    callout('I', P(9.6, 6.2, 1.9), P(8.6, 4.1, 0.02)) +
    callout('D', P(14.0, -1.8, 3.4), P(15.2, 1.0, 1.4));
  return svg('scene', [72, 6, 540, 440], 2.6, body, log.defs + ground.defs);
}

// ---------------------------------------------------------------------------------- the vignettes

const VIGNETTE = [0, 0, 200, 150];

function vignetteL() {
  const P = projection(19, 92, 72);
  const log = logStack(P, { id: 'v-l', x: 0.5, y: 0.5, w: 2.2, d: 2.2, slab: 0.5, count: 4, dur: 4 }, RAMP.L);
  const witness = P(-1.9, 1.2, 2.2);
  const body =
    box(P, { x: -0.2, y: -0.2, z: -0.6, w: 3.6, d: 3.6, h: 0.6 }, HUB) +
    log.body +
    box(P, { x: -2.6, y: 0.6, z: -0.6, w: 1.2, d: 1.2, h: 1.6 }, RAMP.L) +
    `<circle cx="${witness[0]}" cy="${num(witness[1] - 7)}" r="4.5" fill="none" stroke="${RAMP.L.edge}" stroke-width="1.8"/>` +
    cosign(log.head, [witness[0], witness[1] - 7], 4, { rx: 20, ry: 11 });
  return svg('vignette', VIGNETTE, 2.4, body, log.defs);
}

function vignetteU() {
  const P = projection(17, 92, 80);
  const above = P(1.6, 1.6, 3.6);
  const ring = [num(above[0] + 40), num(above[1] - 12)];
  const check = `M${num(ring[0] - 5)},${num(ring[1] + 0.5)} l4,4 l8,-9`;
  const beat = `keyTimes="0;0.3;0.45;0.85;1" ${loop(4)}`;
  const body =
    box(P, { x: 0, y: 0, z: -0.6, w: 3.2, d: 3.2, h: 0.6 }, HUB) +
    box(P, { x: 0.9, y: 0.9, z: 0, w: 1.4, d: 1.4, h: 1.5 }, RAMP.U) +
    `<g transform="translate(${above[0]} ${above[1]})">${envelope(1.5)}` +
    `<animateTransform attributeName="transform" type="translate" values="${above[0]} ${above[1] + 6};${above[0]} ${above[1]};${above[0]} ${above[1]};${above[0]} ${above[1] + 6}" keyTimes="0;0.3;0.85;1" ${loop(4)}/></g>` +
    `<circle cx="${ring[0]}" cy="${ring[1]}" r="12" fill="#ffffff" stroke="${TONES.U}" stroke-width="3" opacity="0">` +
    `<animate attributeName="opacity" values="0;0;1;1;0" ${beat}/><animate attributeName="r" values="18;18;12;12;12" ${beat}/></circle>` +
    `<path d="${check}" fill="none" stroke="${TONES.U}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="20" stroke-dashoffset="20">` +
    `<animate attributeName="stroke-dashoffset" values="20;20;0;0;20" ${beat}/></path>`;
  return svg('vignette', VIGNETTE, 2.2, body);
}

function vignetteC() {
  const P = projection(20, 100, 62);
  const at = P(1.6, 1.6, 1.9);
  const shackle = `M-7,-6 v-6 a7,7 0 0 1 14,0 v6`;
  const body =
    box(P, { x: 0, y: 0, z: -0.6, w: 3.2, d: 3.2, h: 0.6 }, HUB) +
    `<g transform="translate(${at[0]} ${num(at[1] - 4)})">` +
    `<rect x="-26" y="-17" width="52" height="34" rx="4" fill="${PAPER}" stroke="${INK}" stroke-width="2"/>` +
    `<polyline points="-26,-17 0,3 26,-17" fill="none" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
    `<g transform="translate(0 9)"><path d="${shackle}" fill="none" stroke="${TONES.C}" stroke-width="3.2" stroke-linecap="round">` +
    `<animateTransform attributeName="transform" type="translate" values="0 -6;0 -6;0 0;0 0;0 -6" keyTimes="0;0.25;0.4;0.85;1" ${loop(4)}/></path>` +
    `<rect x="-11" y="-6" width="22" height="17" rx="3" fill="${TONES.C}"/><circle cx="0" cy="2" r="2.6" fill="${PAPER}"/></g>` +
    `</g>`;
  return svg('vignette', VIGNETTE, 2, body);
}

function vignetteI() {
  const P = projection(15, 70, 40);
  const path = [P(2.6, 1.3, 0.6), P(3, 1.3, 0.45), P(6, 1.3, 0.45), P(6.4, 1.3, 0.6)];
  const body =
    box(P, { x: 0, y: 0, z: -0.6, w: 3, d: 3, h: 0.6 }, HUB) +
    box(P, { x: 3, y: 0.95, z: -0.3, w: 3, d: 0.9, h: 0.3 }, RAMP.I) +
    `<line x1="${P(3, 1.4, 0.01)[0]}" y1="${P(3, 1.4, 0.01)[1]}" x2="${P(6, 1.4, 0.01)[0]}" y2="${P(6, 1.4, 0.01)[1]}" stroke="${RAMP.I.edge}" stroke-width="2" stroke-dasharray="4 6" stroke-linecap="round">` +
    `<animate attributeName="stroke-dashoffset" values="0;-20" ${loop(1.4)}/></line>` +
    box(P, { x: 6, y: 0, z: -0.6, w: 3, d: 3, h: 0.6 }, HUB) +
    box(P, { x: 0.9, y: 0.9, z: 0, w: 1.1, d: 1.1, h: 1.1 }, RAMP.U) +
    box(P, { x: 7, y: 0.9, z: 0, w: 1.1, d: 1.1, h: 1.1 }, RAMP.U) +
    `<g opacity="0"><animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.08;0.62;0.7;1" ${loop(3.6)}/>` +
    `<animateMotion path="M${pts(path).replace(/ /g, ' L')}" keyPoints="0;1;1" keyTimes="0;0.66;1" calcMode="linear" ${loop(3.6)}/>${envelope(1.1)}</g>`;
  return svg('vignette', VIGNETTE, 1.4, body);
}

function vignetteD() {
  const P = projection(21, 92, 66);
  const glass = P(1.7, 1.6, 2.3);
  const body =
    box(P, { x: 0, y: 0, z: -0.6, w: 3.4, d: 3.2, h: 0.6 }, HUB) +
    directory(P, { x: 0.5, y: 0.6, w: 2.4, d: 1.7, h: 1.4 }, 3.6) +
    `<g><animateTransform attributeName="transform" type="translate" values="-16 6;14 -4;14 -4;-16 6" keyTimes="0;0.45;0.6;1" ${loop(3.6)}/>` +
    `<circle cx="${glass[0]}" cy="${glass[1]}" r="11" fill="#ffffff" fill-opacity="0.45" stroke="${INK}" stroke-width="2.6"/>` +
    `<line x1="${num(glass[0] + 8)}" y1="${num(glass[1] + 8)}" x2="${num(glass[0] + 17)}" y2="${num(glass[1] + 17)}" stroke="${INK}" stroke-width="3.6" stroke-linecap="round"/></g>`;
  return svg('vignette', VIGNETTE, 1.6, body);
}

/** Every drawing, by the name of its marks in the pages. */
export function renderArt() {
  return { scene: scene(), L: vignetteL(), U: vignetteU(), C: vignetteC(), I: vignetteI(), D: vignetteD() };
}

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PAGES = ['index.html', 'es/index.html'];
export const marks = (name) => new RegExp(`<!-- art:${name} -->[\\s\\S]*?<!-- /art:${name} -->`);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const art = renderArt();
  for (const page of PAGES) {
    const file = join(SITE, page);
    let text = readFileSync(file, 'utf8');
    for (const [name, drawing] of Object.entries(art)) {
      if (!marks(name).test(text)) throw new Error(`${page} has no <!-- art:${name} --> marks`);
      text = text.replace(marks(name), `<!-- art:${name} -->${drawing}<!-- /art:${name} -->`);
    }
    writeFileSync(file, text);
  }
  console.log(`drew ${Object.keys(art).join(', ')} into ${PAGES.join(' and ')}`);
}
