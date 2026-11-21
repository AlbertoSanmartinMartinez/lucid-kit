// SPDX-License-Identifier: AGPL-3.0-only
// Signing in with GitHub, by its device flow: what the verifier asks GitHub.
//
// The device flow (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
// needs no web page on the verifier and no client secret: the verifier asks GitHub for a code, the
// person types it at github.com/login/device and says yes, and the verifier asks GitHub, until it is
// done, for a token with which it reads who that person is. The token is used for that one question
// and thrown away. No scope is asked for: the public profile is all it reads.
//
// Not tried against GitHub itself: the tests stand in for it with what its documentation says it answers.

const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** `fetch`, `baseUrl` and `apiUrl` are for the tests, which stand in for GitHub. */
export function githubProvider({ clientId, fetch: fetchImpl = globalThis.fetch, baseUrl = 'https://github.com', apiUrl = 'https://api.github.com', timeoutMs = 10_000, minIntervalSeconds = 5 }) {
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) throw new Error('the GitHub client id of the OAuth app is needed (with its device flow enabled)');
  const ask = async (url, { form, token } = {}) => {
    const res = await fetchImpl(url, {
      method: form ? 'POST' : 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'agenthub-verifier',
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (text.length > 65_536) throw new Error('GitHub answered more than was expected');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: dealt with below */
    }
    return { status: res.status, json };
  };

  return {
    name: 'github',

    /** A code for the person to type, and where: { deviceCode, userCode, verificationUri, expiresIn, interval }. */
    async start() {
      const { status, json } = await ask(`${baseUrl}/login/device/code`, { form: { client_id: clientId, scope: '' } });
      const ok = status === 200 && json && typeof json.device_code === 'string' && typeof json.user_code === 'string' && typeof json.verification_uri === 'string';
      if (!ok) throw new Error(`GitHub did not hand out a device code (${status}${json?.error ? `, ${String(json.error).slice(0, 40)}` : ''})`);
      return {
        deviceCode: json.device_code,
        userCode: json.user_code.slice(0, 20),
        verificationUri: json.verification_uri.startsWith('https://') ? json.verification_uri.slice(0, 200) : `${baseUrl}/login/device`,
        expiresIn: Number.isSafeInteger(json.expires_in) ? Math.min(json.expires_in, 900) : 900,
        interval: Math.max(Number.isSafeInteger(json.interval) ? json.interval : 5, minIntervalSeconds),
      };
    },

    /**
     * Whether the person said yes: { account, name } once they did, { pending: true } while they have
     * not, { slowDown: true } if asked too often, or { failed } with why.
     */
    async poll(deviceCode) {
      const { json } = await ask(`${baseUrl}/login/oauth/access_token`, { form: { client_id: clientId, device_code: deviceCode, grant_type: GRANT } });
      if (json?.error === 'authorization_pending') return { pending: true };
      if (json?.error === 'slow_down') return { slowDown: true };
      if (json?.error === 'access_denied') return { failed: 'the person said no on GitHub' };
      if (json?.error === 'expired_token') return { failed: 'the code ran out before anybody typed it' };
      if (typeof json?.access_token !== 'string') return { failed: 'GitHub did not say yes or no' };
      const user = await ask(`${apiUrl}/user`, { token: json.access_token });
      const { id, login } = user.json ?? {};
      if (user.status !== 200 || !Number.isSafeInteger(id) || id <= 0 || typeof login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
        return { failed: 'GitHub did not say who signed in' };
      }
      return { account: `github:${id}`, name: login };
    },
  };
}
