// SPDX-License-Identifier: Apache-2.0
// Which license each file is under, and that the code under one does not pull in code under a stricter one.
// The client side (protocol, cryptography, MLS, SDK, MCP server) is Apache-2.0 so that anybody can ship it
// inside their own software: if it imported the hub (AGPL-3.0-only), it would not be.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LICENSES = { apache: 'Apache-2.0', agpl: 'AGPL-3.0-only' };

function sources(dir) {
  const found = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) found.push(...sources(path));
    else if (name.endsWith('.mjs')) found.push(path);
  }
  return found;
}

/** The license a file must be under, by where it is. */
function licenseOf(path) {
  if (['src/hub/', 'src/verifier/', 'src/witness/', 'bin/'].some((dir) => path.startsWith(dir))) return LICENSES.agpl;
  return LICENSES.apache;
}
const declared = (text) => /^(?:#![^\n]*\n)?\/\/ SPDX-License-Identifier: (\S+)\n/.exec(text)?.[1] ?? null;
/** The files of this repository a file imports, statically or dynamically, by a relative path. */
function importsOf(path, text) {
  const specifiers = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map((match) => match[1]);
  return specifiers.map((specifier) => relative(ROOT, resolve(ROOT, dirname(path), specifier)));
}

const product = ['src', 'bin'].flatMap(sources);

test('every source file says which license it is under, and it is the one for where it is', () => {
  assert.ok(product.length > 30, 'the source files were found');
  const wrong = product
    .map((path) => ({ path, has: declared(readFileSync(join(ROOT, path), 'utf8')), wants: licenseOf(path) }))
    .filter(({ has, wants }) => has !== wants);
  assert.deepEqual(wrong, []);
});

test('code under a license does not import code under a stricter one', () => {
  // Apache-2.0 may import only Apache-2.0; the hub may import Apache-2.0 and AGPL.
  const allowed = {
    [LICENSES.apache]: [LICENSES.apache],
    [LICENSES.agpl]: [LICENSES.apache, LICENSES.agpl],
  };
  const crossing = [];
  for (const path of [...product, ...sources('test'), ...sources('examples')]) {
    const own = path.startsWith('test/') || path.startsWith('examples/') ? null : licenseOf(path);
    for (const target of importsOf(path, readFileSync(join(ROOT, path), 'utf8'))) {
      if (own && !allowed[own].includes(licenseOf(target))) crossing.push(`${path} -> ${target}`);
    }
  }
  assert.deepEqual(crossing, []);
});

test('the license texts and the notice that says which applies where are there', () => {
  const notice = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
  for (const license of [LICENSES.apache, LICENSES.agpl]) {
    assert.match(notice, new RegExp(license.replace(/[.-]/g, '\\$&')));
    assert.ok(readFileSync(join(ROOT, 'LICENSES', `${license}.txt`), 'utf8').length > 10_000);
  }
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).license, 'Apache-2.0 AND AGPL-3.0-only');
});
