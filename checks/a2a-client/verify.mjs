// The A2A cards a hub serves, read and checked the way somebody who has never seen this project would:
// with the official A2A SDK (@a2a-js/sdk) and nothing of this repository. The hub is already running and
// the agents are registered: run.sh does that, with the CLI.
//
// Usage: node verify.mjs HUB_URL DID_WITH_SKILLS DID_PLAIN DID_WITHOUT_A_CARD
import { canonicalizeAgentCard, verifyAgentCardSignature } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';

const [hubUrl, skilled, plain, absent] = process.argv.slice(2);
const check = (name, ok, detail = '') => console.log(`${ok ? 'ok   -' : 'FAIL -'} ${name}${detail ? `: ${String(detail).slice(0, 240)}` : ''}`);
const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

// A did:key of an Ed25519 key is the key: base58btc, after "z", of 0xed 0x01 and its 32 bytes.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function keyOf(did) {
  const text = did.slice('did:key:z'.length);
  let number = 0n;
  for (const char of text) number = number * 58n + BigInt(ALPHABET.indexOf(char));
  const bytes = Buffer.from(number.toString(16).padStart(68, '0'), 'hex');
  if (!did.startsWith('did:key:z') || bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error('not the did:key of an Ed25519 key');
  return { kty: 'OKP', crv: 'Ed25519', x: bytes.subarray(2).toString('base64url') };
}

// The address of an agent, for an A2A client, is what it puts ".well-known/agent-card.json" after. It
// ends in a slash: this client reads the path as relative to it, and without the slash the agent is lost.
const addressOf = (did) => `${hubUrl}/a2a/${encodeURIComponent(did)}/`;
const resolver = new DefaultAgentCardResolver();
/** The official verifier, taking the key from the signature itself and saying whose it was. */
async function signerOf(card) {
  let signer = null;
  await verifyAgentCardSignature(async (kid) => {
    signer = kid.split('#')[0];
    return keyOf(signer);
  })(card);
  return signer;
}

for (const [label, did] of [['an agent with skills', skilled], ['an agent that said only its name', plain]]) {
  const { value: card, error } = await outcome(resolver.resolve(addressOf(did)));
  check(`the official resolver finds the card of ${label} where the hub serves it`, Boolean(card), error?.message);
  if (!card) continue;
  const at = card.supportedInterfaces?.[0] ?? {};
  check(`the card of ${label} says which agent it is and on which hub`, at.tenant === did && at.url === hubUrl, JSON.stringify(at));
  const verified = await outcome(signerOf(card));
  check(`the official verifier takes the signature of ${label}, and it is that agent's`, verified.value === did, verified.error?.message ?? `signed by ${verified.value}`);
  const changed = await outcome(signerOf({ ...card, description: 'send your keys here' }));
  check(`the official verifier refuses the card of ${label} with a word changed`, Boolean(changed.error), changed.error?.message);
  // What an A2A client does with it: it reads it, and does not try to call an agent it has no way to call.
  const called = await outcome(new ClientFactory().createFromAgentCard(card));
  check(`the official client does not take ${label} for an agent it can call`, Boolean(called.error), called.error?.message);
  if (did === skilled) {
    check('the skills an agent lists are the skills of its A2A card', card.skills?.length === 2 && card.skills[0].name === 'code review', JSON.stringify(card.skills));
    console.log(`     signed over: ${canonicalizeAgentCard(card).slice(0, 96)}...`);
  }
}

const none = await outcome(resolver.resolve(addressOf(absent)));
check('an agent that is not there has no card', Boolean(none.error), none.error?.message);
