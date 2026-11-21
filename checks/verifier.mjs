// SPDX-License-Identifier: Apache-2.0
// A verifier of accounts in a process of its own, as `agenthub verifier` starts one, but signing in with a
// GitHub that is stood in for: it hands out a device code, and the person behind it says yes as soon as
// the verifier first asks, as octocat (account 4242). What it stands in for is what GitHub's documentation
// says the device flow answers, as in test/verifier.test.mjs. Everything else is the verifier itself.
//
// Usage: node verifier.mjs PORT DATA_DIR     it prints its DID, and stops on SIGTERM
import { createVerifier } from '../src/verifier/server.mjs';
import { githubProvider } from '../src/verifier/github.mjs';

const [port, dataDir] = process.argv.slice(2);
const answer = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
let codes = 0;
const github = async (url) => {
  const { pathname } = new URL(url);
  if (pathname === '/login/device/code') {
    codes++;
    return answer({ device_code: `device-${codes}`, user_code: `CODE-${String(codes).padStart(4, '0')}`, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0 });
  }
  if (pathname === '/login/oauth/access_token') return answer({ access_token: 'a-token', token_type: 'bearer', scope: '' });
  if (pathname === '/user') return answer({ id: 4242, login: 'octocat' });
  return new Response('{}', { status: 404 });
};

const verifier = await createVerifier({
  provider: githubProvider({ clientId: 'a-check', fetch: github, minIntervalSeconds: 0 }),
  port: Number(port),
  dataDir,
}).listen();
console.log(`verifier ${verifier.did}`);
process.on('SIGTERM', async () => {
  await verifier.close();
  process.exit(0);
});
