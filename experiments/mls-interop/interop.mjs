// Interoperability experiment, not part of the product: ts-mls and OpenMLS members in the same
// RFC 9420 group. It backs the decision to start MLS with ts-mls behind an adapter: if both speak the
// same wire format, the implementation can be swapped later without changing the protocol.
//
//   (cd openmls-member && cargo build --release)   # the OpenMLS member, one process per group
//   npm install && npm run interop
//
// Each side only ever sees the other's bytes: KeyPackages, Welcomes, commits and application messages
// cross between a Node process (ts-mls) and a Rust process (OpenMLS) as hex over stdin/stdout.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import * as mls from 'ts-mls';
const { createApplicationMessage, createCommit, createGroup, joinGroup, processPrivateMessage, getCiphersuiteImpl, getCiphersuiteFromName,
  defaultCapabilities, defaultLifetime, emptyPskIndex, generateKeyPackage, encodeMlsMessage, decodeMlsMessage } = mls;

const binary = process.argv[2] ?? fileURLToPath(new URL('./openmls-member/target/release/mls-interop', import.meta.url));
const impl = await getCiphersuiteImpl(getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'));
const enc = (s) => new TextEncoder().encode(s), dec = (b) => new TextDecoder().decode(b);
const hex = (bytes) => Buffer.from(bytes).toString('hex'), unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const wire = (message) => encodeMlsMessage({ ...message, version: 'mls10' });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };

/** One OpenMLS member in its own process. `ask` sends a command and returns the answer lines as { tag: value }. */
function openmls() {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    async ask(command) {
      child.stdin.write(`${command}\n`);
      const answer = {};
      for (;;) {
        const { value, done } = await lines.next();
        if (done) throw new Error(`openmls exited during: ${command.slice(0, 40)}`);
        if (value === 'end') return answer;
        const space = value.indexOf(' ');
        answer[space === -1 ? value : value.slice(0, space)] = space === -1 ? '' : value.slice(space + 1);
      }
    },
    close: () => child.stdin.end(),
  };
}

const tsMember = (did) => generateKeyPackage({ credentialType: 'basic', identity: enc(did) }, defaultCapabilities(), defaultLifetime, [], impl);
const tsSend = async (state, text) => { const r = await createApplicationMessage(state, enc(text), impl); return { state: r.newState, bytes: wire({ privateMessage: r.privateMessage, wireformat: 'mls_private_message' }) }; };
const tsReceive = async (state, bytes) => {
  const message = decodeMlsMessage(bytes, 0)[0];
  const r = message.wireformat === 'mls_private_message'
    ? await processPrivateMessage(state, message.privateMessage, emptyPskIndex, impl)
    : await mls.processPublicMessage(state, message.publicMessage, emptyPskIndex, impl);
  return { state: r.newState, text: r.kind === 'applicationMessage' ? dec(r.message) : null, kind: r.kind };
};
const commitBytes = (commit) => wire(commit.commit);
const epochOf = (state) => Number(state.groupContext.epoch);

// ---------------------------------------------------------------- 1. ts-mls creates the group, OpenMLS joins
console.log('--- group created by ts-mls; OpenMLS joins from its Welcome');
{
  const rust = openmls();
  const a = await tsMember('did:key:zTsA');
  let A = await createGroup(enc('interop-1'), a.publicPackage, a.privatePackage, [], impl);
  const { kp } = await rust.ask('kp did:key:zOpenMLS');
  const theirs = decodeMlsMessage(unhex(kp), 0)[0];
  check('ts-mls parses the OpenMLS KeyPackage', theirs?.wireformat === 'mls_key_package');
  const add = await createCommit({ state: A, cipherSuite: impl }, { extraProposals: [{ proposalType: 'add', add: { keyPackage: theirs.keyPackage } }], ratchetTreeExtension: true });
  A = add.newState;
  const joined = await rust.ask(`join ${hex(wire({ welcome: add.welcome, wireformat: 'mls_welcome' }))}`);
  check('OpenMLS joins from the ts-mls Welcome', joined.joined === 'epoch=1 members=did:key:zTsA,did:key:zOpenMLS', JSON.stringify(joined));

  let m = await tsSend(A, 'hola desde ts-mls'); A = m.state;
  check('OpenMLS decrypts a ts-mls message', (await rust.ask(`recv ${hex(m.bytes)}`)).app === 'hola desde ts-mls');
  let r = await tsReceive(A, unhex((await rust.ask('send hola desde OpenMLS')).msg)); A = r.state;
  check('ts-mls decrypts an OpenMLS message', r.text === 'hola desde OpenMLS');

  const update = await createCommit({ state: A, cipherSuite: impl }); A = update.newState;
  const merged = await rust.ask(`recv ${hex(commitBytes(update))}`);
  check('OpenMLS processes a ts-mls commit (update path)', merged['commit-merged']?.startsWith('epoch=2 '), JSON.stringify(merged));
  r = await tsReceive(A, unhex((await rust.ask('update')).commit)); A = r.state;
  check('ts-mls processes an OpenMLS commit (self update)', r.kind === 'newState' && epochOf(A) === 3, `epoch ${epochOf(A)}`);
  m = await tsSend(A, 'epoca 3, de ts-mls'); A = m.state;
  check('messages still flow after both commits (ts-mls -> OpenMLS)', (await rust.ask(`recv ${hex(m.bytes)}`)).app === 'epoca 3, de ts-mls');
  r = await tsReceive(A, unhex((await rust.ask('send epoca 3, de OpenMLS')).msg)); A = r.state;
  check('messages still flow after both commits (OpenMLS -> ts-mls)', r.text === 'epoca 3, de OpenMLS');

  // A third member, also ts-mls, added by ts-mls; then removed by OpenMLS.
  const c = await tsMember('did:key:zTsC');
  const addC = await createCommit({ state: A, cipherSuite: impl }, { extraProposals: [{ proposalType: 'add', add: { keyPackage: c.publicPackage } }], ratchetTreeExtension: true });
  A = addC.newState;
  const withC = await rust.ask(`recv ${hex(commitBytes(addC))}`);
  check('OpenMLS processes the commit that adds a third member', withC['commit-merged']?.startsWith('epoch=4 members=did:key:zTsA,did:key:zOpenMLS,did:key:zTsC'), JSON.stringify(withC));
  let C = await joinGroup(addC.welcome, c.publicPackage, c.privatePackage, emptyPskIndex, impl);
  m = await tsSend(C, 'soy C'); C = m.state;
  check('OpenMLS decrypts the third member', (await rust.ask(`recv ${hex(m.bytes)}`)).app === 'soy C');
  r = await tsReceive(A, m.bytes); A = r.state;
  const removal = unhex((await rust.ask('remove did:key:zTsC')).commit);
  r = await tsReceive(A, removal); A = r.state;
  check('ts-mls processes the OpenMLS commit that removes a member', epochOf(A) === 5, `epoch ${epochOf(A)}`);
  const after = unhex((await rust.ask('send solo para los que quedan')).msg);
  r = await tsReceive(A, after); A = r.state;
  check('the remaining ts-mls member reads the new epoch', r.text === 'solo para los que quedan');
  let leaked = false;
  try { const x = await tsReceive(C, after); leaked = x.text !== null; } catch { /* expected */ }
  check('the removed member cannot read the new epoch', !leaked);
  rust.close();
}

// ---------------------------------------------------------------- 2. OpenMLS creates the group, ts-mls joins
console.log('--- group created by OpenMLS; ts-mls joins from its Welcome');
{
  const rust = openmls();
  await rust.ask('create did:key:zOpenMLS');
  const b = await tsMember('did:key:zTsB');
  const added = await rust.ask(`add ${hex(wire({ keyPackage: b.publicPackage, wireformat: 'mls_key_package' }))}`);
  check('OpenMLS accepts the ts-mls KeyPackage', typeof added.welcome === 'string', JSON.stringify(added).slice(0, 120));
  const welcome = decodeMlsMessage(unhex(added.welcome), 0)[0];
  let B = await joinGroup(welcome.welcome, b.publicPackage, b.privatePackage, emptyPskIndex, impl);
  check('ts-mls joins from the OpenMLS Welcome (tree taken from its extension)', epochOf(B) === 1, `epoch ${epochOf(B)}`);
  let r = await tsReceive(B, unhex((await rust.ask('send hola desde OpenMLS')).msg)); B = r.state;
  check('ts-mls decrypts an OpenMLS message', r.text === 'hola desde OpenMLS');
  let m = await tsSend(B, 'hola desde ts-mls'); B = m.state;
  check('OpenMLS decrypts a ts-mls message', (await rust.ask(`recv ${hex(m.bytes)}`)).app === 'hola desde ts-mls');
  const update = await createCommit({ state: B, cipherSuite: impl }); B = update.newState;
  const merged = await rust.ask(`recv ${hex(commitBytes(update))}`);
  check('OpenMLS processes a ts-mls commit', merged['commit-merged']?.startsWith('epoch=2 '), JSON.stringify(merged));
  r = await tsReceive(B, unhex((await rust.ask('update')).commit)); B = r.state;
  check('ts-mls processes an OpenMLS commit', epochOf(B) === 3, `epoch ${epochOf(B)}`);
  r = await tsReceive(B, unhex((await rust.ask('send fin')).msg)); B = r.state;
  check('messages flow in the last epoch', r.text === 'fin');
  rust.close();
}
const tsMlsVersion = JSON.parse(readFileSync(new URL('./node_modules/ts-mls/package.json', import.meta.url))).version;
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} interop checks passed (ts-mls ${tsMlsVersion} <-> openmls 0.9.2)`);
process.exit(passed === results.length ? 0 : 1);
