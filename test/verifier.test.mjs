// SPDX-License-Identifier: Apache-2.0
// The verifier of accounts: a controller asks, with a request signed by its key; the person behind it
// signs in with GitHub by its device flow; and the verifier signs that the key is that account. GitHub
// is stood in for here, with what its documentation says it answers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerifier } from '../src/verifier/server.mjs';
import { githubProvider } from '../src/verifier/github.mjs';
import { createDelegation, generateIdentity, startVerification, submitAttestation, verifyAttestation, waitForVerification } from '../src/sdk/index.mjs';
import { accountReference, createVerificationRequest } from '../src/core/attestation.mjs';

const SECRET = Buffer.alloc(32, 3);
import { CONTEXT, createProof } from '../src/core/proof.mjs';
import { startHub } from './helpers.mjs';

/** GitHub, as far as the device flow goes: codes that a person approves, denies or leaves waiting. */
function fakeGithub() {
  const codes = new Map(); // device_code -> { user_code, state, user, slowDown }
  const calls = { start: 0, poll: 0, user: 0 };
  const tokens = new Map();
  let up = true;
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init) => {
    if (!up) throw new TypeError('fetch failed');
    const { pathname } = new URL(url);
    const form = new URLSearchParams(init?.body ?? '');
    if (pathname === '/login/device/code') {
      calls.start++;
      assert.equal(form.get('client_id'), 'the-client-id');
      const deviceCode = `device-${codes.size}`;
      const userCode = `CODE-${String(codes.size).padStart(4, '0')}`;
      codes.set(deviceCode, { userCode, state: 'pending', user: null, slowDown: false });
      return answer(200, { device_code: deviceCode, user_code: userCode, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0 }); // GitHub says 5: no waiting in the tests
    }
    if (pathname === '/login/oauth/access_token') {
      calls.poll++;
      const code = codes.get(form.get('device_code'));
      if (!code) return answer(200, { error: 'expired_token' });
      if (code.slowDown) {
        code.slowDown = false;
        return answer(200, { error: 'slow_down' });
      }
      if (code.state === 'pending') return answer(200, { error: 'authorization_pending' });
      if (code.state === 'denied') return answer(200, { error: 'access_denied' });
      const token = `token-${form.get('device_code')}`;
      tokens.set(token, code.user);
      return answer(200, { access_token: token, token_type: 'bearer', scope: '' });
    }
    if (pathname === '/user') {
      calls.user++;
      const user = tokens.get(init.headers.authorization.replace(/^Bearer /, ''));
      return user ? answer(200, user) : answer(401, { message: 'Bad credentials' });
    }
    return answer(404, {});
  };
  const byUserCode = (userCode) => [...codes.values()].find((code) => code.userCode === userCode);
  return {
    fetch,
    calls,
    approve: (userCode, user) => Object.assign(byUserCode(userCode), { state: 'approved', user }),
    deny: (userCode) => Object.assign(byUserCode(userCode), { state: 'denied' }),
    slowDown: (userCode) => Object.assign(byUserCode(userCode), { slowDown: true }),
    down: () => (up = false),
  };
}

async function startVerifierFor(t, github, options = {}) {
  const provider = githubProvider({ clientId: 'the-client-id', fetch: github.fetch, minIntervalSeconds: 0, ...options.provider });
  const verifier = await createVerifier({ provider, port: 0, quiet: true, referenceSecret: SECRET, ...options.verifier }).listen();
  t.after(() => verifier.close());
  return verifier;
}

test('a person signs in with GitHub, and the agents of their controller become tier "account" on a hub that trusts the verifier', async (t) => {
  const github = fakeGithub();
  const verifier = await startVerifierFor(t, github);
  const info = await (await fetch(`${verifier.url}/v1/info`)).json();
  assert.deepEqual([info.verifier, info.provider], [verifier.did, 'github']);
  assert.deepEqual(await (await fetch(`${verifier.url}/healthz`)).json(), { ok: true });

  const person = generateIdentity();
  const started = await startVerification(verifier.url, person);
  assert.match(started.user_code, /^CODE-/);
  assert.equal(started.verification_uri, 'https://github.com/login/device');
  // While nobody has said yes on GitHub, it waits.
  const pending = await (await fetch(`${verifier.url}/v1/verifications/${started.id}`)).json();
  assert.equal(pending.status, 'pending');

  github.approve(started.user_code, { id: 583231, login: 'octocat' });
  const { attestation, account, name } = await waitForVerification(verifier.url, { ...started, interval: 0 }, { controller: person.did });
  const verdict = verifyAttestation(attestation);
  assert.deepEqual([verdict.ok, verdict.verifier, verdict.controller, verdict.account], [true, verifier.did, person.did, accountReference(SECRET, 'github:583231')]);
  assert.deepEqual([account, name], ['github:583231', 'octocat'], 'which account it was is told to whoever asked');
  assert.ok(!JSON.stringify(attestation).includes('583231') && !JSON.stringify(attestation).includes('octocat'), 'and is in no attestation');
  assert.equal(github.calls.user, 1, 'who signed in is asked once');
  // What it answers afterwards is the attestation, and no token of GitHub.
  const done = await (await fetch(`${verifier.url}/v1/verifications/${started.id}`)).json();
  assert.deepEqual(Object.keys(done).sort(), ['account', 'attestation', 'id', 'name', 'status']);

  const hub = await startHub(t, { trustedVerifiers: [verifier.did] });
  const agent = await hub.agent('agent');
  await agent.attachDelegation(createDelegation(person, { subject: agent.did }));
  await submitAttestation(hub.url, attestation);
  assert.equal((await agent.usage()).tier, 'account');
  assert.equal((await agent.getAgent(agent.did)).controller.verified_as, accountReference(SECRET, 'github:583231'));
});

test('the verifier takes only requests signed by the controller they name, for it, fresh and once', async (t) => {
  const github = fakeGithub();
  const verifier = await startVerifierFor(t, github);
  const person = generateIdentity();
  const post = async (body) => {
    const res = await fetch(`${verifier.url}/v1/verifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return `${res.status} ${(await res.json()).error?.code ?? 'ok'}`;
  };
  const good = createVerificationRequest(person, { verifierUrl: verifier.url });
  const resigned = (change, signer = person) => {
    const request = { ...good.request, nonce: `${good.request.nonce}x`, ...change };
    return { request, proof: createProof(CONTEXT.VERIFICATION_REQUEST, request, signer) };
  };
  const mallory = generateIdentity();
  assert.equal(await post({ request: { ...good.request, controller: mallory.did }, proof: good.proof }), '400 invalid_request', 'another controller, same signature');
  assert.equal(await post(resigned({ controller: person.did }, mallory)), '400 invalid_request', 'signed by someone else');
  assert.equal(await post(resigned({ verifier: 'https://other-verifier.example.com' })), '401 wrong_verifier');
  assert.equal(await post(resigned({ at: new Date(Date.now() - 10 * 60_000).toISOString() })), '400 invalid_request', 'too old');
  assert.equal(await post({ request: good.request, proof: createProof(CONTEXT.DELEGATION, good.request, person) }), '400 invalid_request', 'signed for something else');
  assert.equal(github.calls.start, 0, 'GitHub was asked nothing for any of them');
  assert.equal(await post(good), '201 ok');
  assert.equal(await post(good), '409 replayed_request');
  assert.equal(github.calls.start, 1);

  const unknown = await fetch(`${verifier.url}/v1/verifications/${'A'.repeat(22)}`);
  assert.equal(unknown.status, 404);
});

test('a verification that is denied, or whose answer from GitHub does not say who signed in, fails', async (t) => {
  const github = fakeGithub();
  const verifier = await startVerifierFor(t, github);
  const person = generateIdentity();

  const denied = await startVerification(verifier.url, person);
  github.deny(denied.user_code);
  const failure = await waitForVerification(verifier.url, { ...denied, interval: 0 }, { controller: person.did }).catch((err) => err);
  assert.equal(failure.code, 'verification_failed');
  assert.match(failure.reason, /said no/);

  for (const user of [{ id: 'one', login: 'x' }, { id: 7, login: 'not a login' }, { id: -1, login: 'x' }, {}]) {
    const started = await startVerification(verifier.url, person);
    github.approve(started.user_code, user);
    const err = await waitForVerification(verifier.url, { ...started, interval: 0 }, { controller: person.did }).catch((caught) => caught);
    assert.equal(err.code, 'verification_failed', JSON.stringify(user));
  }

  // A controller that waits for somebody else's verification gets nothing it could use as its own.
  const other = generateIdentity();
  const theirs = await startVerification(verifier.url, other);
  github.approve(theirs.user_code, { id: 9, login: 'them' });
  await assert.rejects(waitForVerification(verifier.url, { ...theirs, interval: 0 }, { controller: person.did }), /not a good one for this controller/);
});

test('the verifier asks GitHub no more often than it allows, and says so when GitHub is not there', async (t) => {
  const github = fakeGithub();
  const verifier = await startVerifierFor(t, github);
  const person = generateIdentity();
  const started = await startVerification(verifier.url, person);
  const look = async () => (await (await fetch(`${verifier.url}/v1/verifications/${started.id}`)).json()).status;

  github.slowDown(started.user_code);
  assert.equal(await look(), 'pending');
  const asked = github.calls.poll;
  // GitHub asked to slow down: five more seconds between questions. Looking again now asks it nothing.
  for (let i = 0; i < 5; i++) assert.equal(await look(), 'pending');
  assert.equal(github.calls.poll, asked);

  github.down();
  const res = await fetch(`${verifier.url}/v1/verifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(createVerificationRequest(person, { verifierUrl: verifier.url })),
  });
  assert.equal(`${res.status} ${(await res.json()).error.code}`, '502 provider_unreachable');
});

test('a verifier reachable from other machines has to know its address, and GitHub needs the client id of the app', () => {
  const provider = githubProvider({ clientId: 'x', fetch: async () => {} });
  assert.throws(() => createVerifier({ provider, host: '0.0.0.0', quiet: true }), /needs the address it is reached at/);
  assert.throws(() => githubProvider({ clientId: '' }), /client id/);
});

test('behind a proxy the verifier counts each client, not the proxy', async (t) => {
  const github = fakeGithub();
  const limits = { start: { burst: 2, perMinute: 2 } };
  const start = (verifier, forwardedFor) =>
    fetch(`${verifier.url}/v1/verifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
      body: JSON.stringify(createVerificationRequest(generateIdentity(), { verifierUrl: verifier.url })),
    }).then((res) => res.status);

  // Behind one proxy: the last address of the header is the client's, whatever the client put before it.
  const proxied = await startVerifierFor(t, github, { verifier: { trustProxy: 1, limits } });
  assert.deepEqual([await start(proxied, '203.0.113.7'), await start(proxied, '203.0.113.7'), await start(proxied, '203.0.113.7')], [201, 201, 429]);
  assert.equal(await start(proxied, '203.0.113.8'), 201, 'another client has its own allowance');
  assert.equal(await start(proxied, '198.51.100.1, 203.0.113.7'), 429, 'what a client writes in the header before the proxy does not count');

  // With no proxy, the header is whatever the client says, and is not listened to.
  const direct = await startVerifierFor(t, github, { verifier: { limits } });
  assert.deepEqual([await start(direct, '203.0.113.7'), await start(direct, '203.0.113.8'), await start(direct, '203.0.113.9')], [201, 201, 429]);
});

