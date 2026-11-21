// Two MCP servers of this repository, each a process of its own with its own identity, driven by the
// official MCP client (@modelcontextprotocol/sdk) against a hub that is already running: the twelve tools,
// in a flow between two agents. Started by run.sh, which also starts and stops the hub.
//
// Usage: node flow.mjs REPO IDENTITIES_DIR HUB_URL
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [repo, idDir, hubUrl] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok   -' : 'FAIL -'} ${name}${detail ? `: ${String(detail).slice(0, 240)}` : ''}`);
};

async function connect(label) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: 'node', args: [`${repo}/bin/agenthub.mjs`, 'mcp'],
    env: { PATH: process.env.PATH, AGENTHUB_URL: hubUrl, AGENTHUB_IDENTITY: `${idDir}/${label}.json` }, stderr: 'pipe',
  });
  transport.stderr?.on('data', (c) => stderr.push(c.toString()));
  const client = new Client({ name: 'sdk-flow', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });
  const text = async (name, args) => { const r = await call(name, args); if (r.isError) throw new Error(`${name}: ${r.content[0].text}`); return r.content[0].text; };
  return { client, call, text, stderr, label };
}

const a = await connect('reviewer');
const b = await connect('builder');
check('initialize negotiates a version the SDK accepts', true, `server ${JSON.stringify(a.client.getServerVersion())}, capabilities ${JSON.stringify(a.client.getServerCapabilities())}`);
check('instructions delivered', /untrusted/.test(a.client.getInstructions() ?? ''));
const { tools } = await a.client.listTools();
check('tools/list passes the SDK schema', tools.length === 12, tools.map((t) => t.name).join(', '));

const topic = `sdk.flow.t${Date.now().toString(36)}`;
check('hub_status before registering', JSON.parse(await a.text('hub_status')).registered === false);
const early = await b.call('hub_subscribe', { topic });
check('unregistered agent gets a tool error, not a crash', early.isError === true, early.content[0].text);
const me = JSON.parse(await a.text('hub_register', { name: 'sdk-reviewer', description: 'Revisa código Rust en busca de unsafe' }));
const other = JSON.parse(await b.text('hub_register', { name: 'sdk-builder' }));
check('hub_register (real proof of work, 18 bits)', /^did:key:z6Mk/.test(me.did) && /^did:key:z6Mk/.test(other.did));
await a.text('hub_create_topic', { name: topic, description: 'Peticiones de revisión de código Rust (flujo SDK)', schema: { type: 'object', required: ['repo', 'pr'], properties: { repo: { type: 'string' }, pr: { type: 'integer' } } } });
await a.text('hub_subscribe', { topic });
check('hub_create_topic + hub_subscribe', JSON.parse(await a.text('hub_status')).subscriptions.includes(topic));
check('hub_search_topics', (await b.text('hub_search_topics', { query: 'revisión de código en Rust flujo SDK' })).includes(topic));
check('hub_search_agents', /sdk-reviewer/.test(await b.text('hub_search_agents', { query: 'revisa unsafe' })));
check('hub_get_topic', /"required"/.test(await b.text('hub_get_topic', { topic })));
const invalid = await b.call('hub_publish', { topic, type: 'request', data: { repo: 'acme/parser', pr: 'cuarenta' } });
check('hub_publish rejects data off-contract', invalid.isError === true && /schema_validation_failed/.test(invalid.content[0].text), invalid.content[0].text);
check('hub_publish', JSON.parse(await b.text('hub_publish', { topic, type: 'request', data: { repo: 'acme/parser', pr: 42 } })).delivered_to === 1);
const inbox = await a.text('hub_inbox');
check('hub_inbox delivers the event wrapped as untrusted', /^1 new message/.test(inbox) && /trust="untrusted"/.test(inbox) && /"pr": 42/.test(inbox));
check('hub_inbox delivers once', (await a.text('hub_inbox')) === 'No new messages.');
const sent = JSON.parse(await a.text('hub_send', { to: other.did, type: 'question', data: { text: '¿Reviso también los tests?' } }));
check('hub_send (encrypted direct message)', sent.encrypted === true);
check('direct message arrives decrypted', /¿Reviso también los tests\?/.test(await b.text('hub_inbox')));
const priv = `${topic}.private`;
const created = JSON.parse(await a.text('hub_create_topic', { name: priv, description: 'Canal privado del flujo SDK', schema: { type: 'object', required: ['text'] }, private: true, members: [other.did] }));
check('hub_create_topic private', created.private === true && created.member_count === 2);
await b.text('hub_subscribe', { topic: priv });
await a.text('hub_publish', { topic: priv, type: 'note', data: { text: 'solo para el equipo' } });
check('private topic event decrypted by the member', /solo para el equipo/.test(await b.text('hub_inbox')));
const members = JSON.parse(await a.text('hub_topic_members', { topic: priv, remove: [other.did] }));
check('hub_topic_members remove rotates the key', members.epoch === 2 && members.members.length === 1 && members.removed.length === 1);
check('removed member can no longer publish', (await b.call('hub_publish', { topic: priv, type: 'note', data: { text: 'sigo aquí' } })).isError === true);
check('hub_unsubscribe', JSON.parse(await b.text('hub_unsubscribe', { topic })).subscribed === false);
const bad = await b.call('hub_send', { to: 42, type: 'x' });
check('bad arguments are refused before reaching the hub', bad.isError === true && /^Invalid arguments/.test(bad.content[0].text), bad.content[0].text);
let unknown; try { await b.call('rm_rf'); unknown = 'no error'; } catch (err) { unknown = `${err.code}: ${err.message}`; }
check('unknown tool is a protocol error', /-32602/.test(unknown), unknown);
await a.client.ping(); check('ping', true);
await a.client.close(); await b.client.close();
console.log(`     what the reviewer's server wrote to stderr: ${a.stderr.join('').trim().split('\n').slice(0, 3).join(' | ')}`);
process.exit(results.some((result) => !result.ok) ? 1 : 0);
