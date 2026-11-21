// SPDX-License-Identifier: Apache-2.0
// Makes what the landing page shows as real protocol bytes, with the code of this repository:
//   - the signed event at the top of the page, signed by an agent with the core (src/core/sign.mjs);
//   - the checkpoint of the "Logged" section, which a hub serves at /v1/log/note: that of a hub
//     and a witness started here, in memory, with that agent and another registered and a topic made.
// It writes site/assets/fixtures.mjs and puts the checkpoint into both pages, between their
// <!-- checkpoint --> and <!-- /checkpoint --> marks. New keys each time: run it again rather than
// editing what it writes.
//
// Usage: node site/tools/fixtures.mjs

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signEvent } from '../../src/core/sign.mjs';
import { createHub } from '../../src/hub/server.mjs';
import { createWitness } from '../../src/witness/server.mjs';
import { AgentClient, generateIdentity } from '../../src/sdk/index.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'es/index.html'];
const TOPIC = {
  name: 'dev.rust.code-review.requests',
  description: 'Code review requests for Rust repositories',
  schema: { type: 'object', required: ['repo', 'pr'], properties: { repo: { type: 'string' }, pr: { type: 'integer' } } },
};

// A hub with a witness that watches its log, both in memory.
const hubKey = generateIdentity();
const witness = await createWitness({ port: 0, quiet: true, logs: [hubKey.did], name: 'witness.example/w1' }).listen();
const hub = await createHub({ port: 0, quiet: true, powDifficulty: 8, identity: hubKey, witnesses: [`${witness.verifier}@${witness.url}`], witnessIntervalMs: 3_600_000 }).listen();
const builder = generateIdentity();
const agents = [];
try {
  const reviewer = new AgentClient({ hubUrl: hub.url, identity: generateIdentity() });
  const asker = new AgentClient({ hubUrl: hub.url, identity: builder });
  agents.push(reviewer, asker);
  await reviewer.register({ name: 'rust-reviewer', description: 'Reviews Rust code' });
  await asker.register({ name: 'acme-builder', description: 'Builds the parsers of Acme' });
  await reviewer.createTopic(TOPIC);
  if ((await hub.witnessNow()) !== 1) throw new Error('the witness did not cosign the log');
  const res = await fetch(`${hub.url}/v1/log/note`);
  if (!res.ok) throw new Error(`the hub answered ${res.status} for its note`);
  const note = await res.text();

  // The event one of those agents publishes on that topic, as the SDK writes one: the page lets its
  // visitor change it and checks the signature again.
  const envelope = signEvent(
    {
      specversion: '1.0',
      id: randomUUID(),
      source: builder.did,
      type: 'dev.rust.code-review.request',
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      subject: TOPIC.name,
      dataschema: `https://hub.example/v1/topics/${TOPIC.name}/schema`,
      data: { repo: 'https://github.com/acme/parser', pr: 42 },
    },
    builder,
  );

  writeFileSync(
    join(SITE, 'assets/fixtures.mjs'),
    `// SPDX-License-Identifier: Apache-2.0\n// Made by site/tools/fixtures.mjs: run it again for new ones rather than editing this file.\n\n` +
      `/** An event signed by an agent, as a hub receives it. */\nexport const demoEnvelope = ${JSON.stringify(envelope, null, 2)};\n\n` +
      `/** The checkpoint of a hub's log, signed by the hub and cosigned by a witness, as GET /v1/log/note serves it. */\nexport const checkpointNote = ${JSON.stringify(note)};\n\n` +
      `/** The key that witness cosigns with, as it prints it: what a client that trusts it is given. */\nexport const witnessVerifier = ${JSON.stringify(witness.verifier)};\n`,
  );
  const html = note.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const page of PAGES) {
    const file = join(SITE, page);
    const text = readFileSync(file, 'utf8');
    const marked = /<!-- checkpoint -->[\s\S]*?<!-- \/checkpoint -->/;
    if (!marked.test(text)) throw new Error(`${page} has no <!-- checkpoint --> marks`);
    writeFileSync(file, text.replace(marked, `<!-- checkpoint -->${html}<!-- /checkpoint -->`));
  }
  console.log(`event signed by ${builder.did}\ncheckpoint of ${note.split('\n')[1]} entries, cosigned by witness.example/w1`);
} finally {
  await Promise.all(agents.map((agent) => agent.close()));
  await hub.close();
  await witness.close();
}
