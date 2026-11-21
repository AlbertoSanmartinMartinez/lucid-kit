// SPDX-License-Identifier: Apache-2.0
// What the store keeps on disk: a snapshot and the journal of what came after it. A journal that does
// not follow on from its snapshot - a copy of the two made in the wrong order - is refused, not replayed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/hub/store.mjs';

const block = (agent, blocked) => ({ type: 'block.put', agent, blocked });

test('a hub does not start from a journal that does not follow on from its snapshot', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agenthub-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const live = join(dir, 'live');
  const copy = join(dir, 'copy');

  const store = new Store({ dataDir: live }).load();
  store.commit(block('a', 'x1'));
  store.commit(block('a', 'x2'));
  store.compact(); // snapshot at operation 2, journal empty
  // A careless copy takes the snapshot now...
  const early = new Store({ dataDir: copy }).load();
  early.close();
  copyFileSync(join(live, 'snapshot.json'), join(copy, 'snapshot.json'));
  store.commit(block('a', 'x3'));
  store.compact(); // snapshot at 3, journal emptied
  store.commit(block('a', 'x4'));
  // ...and the journal later: operation 3 is in neither.
  copyFileSync(join(live, 'journal.jsonl'), join(copy, 'journal.jsonl'));
  store.close();
  assert.throws(() => new Store({ dataDir: copy }).load(), /does not follow on from its snapshot: operation 3 is missing/);

  // The live data, and a copy made journal first, start.
  const again = new Store({ dataDir: live }).load();
  assert.deepEqual([...again.blocks.get('a')], ['x1', 'x2', 'x3', 'x4']);
  again.close();
});

test('a hub tells whoever watches it how things stand, in counts that say nobody', async (t) => {
  const { startHub } = await import('./helpers.mjs');
  const hub = await startHub(t, { metricsPort: 0 });
  const [alice, bob] = await Promise.all([hub.agent('alice'), hub.agent('bob')]);
  await alice.send(bob.did, { type: 'note', data: {}, encrypt: false });
  await fetch(`${hub.url}/v1/nothing-here`);
  const res = await fetch(`http://127.0.0.1:${hub.metricsPort}/metrics`);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  const text = await res.text();
  assert.match(text, /^agenthub_agents\{status="active"\} 2$/m);
  assert.match(text, /^agenthub_inbox_entries 1$/m);
  assert.match(text, /^agenthub_requests_total\{status="4xx"\} [1-9]/m);
  assert.match(text, /^# TYPE agenthub_requests_total counter$/m);
  assert.ok(!text.includes(alice.did) && !text.includes('did:key'), 'no DID in them');
  assert.equal((await fetch(`http://127.0.0.1:${hub.metricsPort}/other`)).status, 404);
  assert.equal((await fetch(`${hub.url}/metrics`)).status, 404, 'not on the port of the hub');
});

test('the metrics of a hub are for this machine alone, unless its operator says where they are served', async (t) => {
  const { networkInterfaces } = await import('node:os');
  const { startHub } = await import('./helpers.mjs');
  // An address of this machine that is not its loopback: what another machine, or another container, would reach it at.
  const outside = Object.values(networkInterfaces()).flat().find((address) => address.family === 'IPv4' && !address.internal)?.address;
  if (!outside) return t.skip('this machine has no address but its loopback');
  const reaches = (port) => fetch(`http://${outside}:${port}/metrics`).then((res) => res.status, () => 'refused');

  const hub = await startHub(t, { metricsPort: 0 });
  assert.equal(await reaches(hub.metricsPort), 'refused', 'by default nobody outside reaches them');

  // In a container the loopback is the container's own: whoever scrapes it comes from its network.
  const lines = [];
  const open = await startHub(t, { metricsPort: 0, metricsHost: '0.0.0.0', log: (line) => lines.push(line) });
  assert.equal(await reaches(open.metricsPort), 200);
  assert.ok(lines.some((line) => /reachable from other machines/.test(line)), 'and the hub says so when it starts');
});
