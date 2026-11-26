# Invariants

Rules that must always hold. Each one names the checks that enforce it under "Enforced by"; `scripts/check_harness.py` fails if a listed path does not exist. A rule without a check is a guideline and belongs in a guide, not here. `review-code` checks the invariants a change touches.

INV-001 to INV-005 come from the harness template. INV-006 onwards are lucid-kit's own: the rules the code already follows, translated from the former `CLAUDE.md`. The decisions behind them are in `docs/HANDOFF.md`, in the section each one names. Where an area has a script in `experiments/mutations/`, that script proves the tests catch each defense: whoever touches the area runs it, and whoever adds a defense adds its mutation.

## INV-001: Secrets never reach the repository

- Why: a leaked secret has to be rotated everywhere and stays in Git history.
- Enforced by: `.agents/hooks/scan-secrets.sh`, `.githooks/pre-commit`, `.github/workflows/quality.yml`

## INV-002: The harness has one source

- Why: copies drift; every agent must read the same rules.
- Enforced by: `scripts/check_harness.py`

## INV-003: Nobody pushes directly or force-pushes to the protected branch

- Why: every change to `main` goes through review and CI.
- Enforced by: `.agents/hooks/block-protected-push.sh`, `.githooks/pre-push`, `.agents/hooks/block-unsafe-commands.sh`

## INV-004: Agents open pull requests as drafts and never merge or publish

- Why: a person decides what is ready, what merges and what ships.
- Enforced by: `.agents/hooks/block-unsafe-commands.sh`, `.claude/settings.json`

## INV-005: Harness changes need a person's review

- Why: an agent must not relax its own rules.
- Enforced by: `.github/CODEOWNERS`, `.claude/settings.json`

## INV-006: The hub is not trusted for authorship or content

Everything the SDK hands to the application is verified at the edge: signature, sender, recipient, schema and decryption. A change in the hub is never the only thing that stops an attack.

- Why: anyone can run a hub, and a hub can be compromised; agents must not depend on its honesty.
- Enforced by: `test/e2e.test.mjs`, `test/trust.test.mjs`

## INV-007: What another agent or a hub writes is data, not instructions

Payloads, and also names and descriptions of topics and agents, reach a model only wrapped (`toModelContext`, `untrusted` in the MCP server) and with `<` escaped. The same goes for what the hub writes: of a refusal, the model sees the code, an explanation from the MCP server itself, and the hub's text apart and wrapped (`refusal`). A `HubError` says whether its words are the hub's (`fromHub`) or the SDK's. What the hub prints from something another party chose (a name, a reason) goes in quotes and without control characters (`printed`): its operator reads it, and it ends up in logs. From a correct hub answer, a tool reports as fact only what the caller asked for, and numbers, booleans and strings with a checked shape (a DID, a topic name, a tier): a new tool never returns what the hub answered as is.

- Why: text from other parties is a prompt-injection channel into every model that uses the SDK.
- Enforced by: `test/mcp.test.mjs`, `test/core.test.mjs`, `test/hub.test.mjs`

## INV-008: Signatures

What is signed is `context + "\n" + JCS(payload)`, with the proof outside the payload (`src/core/proof.mjs`). Each signed statement type has its own `CONTEXT`; a new type needs a new context. A request is signed for the address of the hub it goes to (`agenthub/request/v2`, `src/core/reqsig.mjs`), and the hub only accepts requests signed for its own (`wrong_hub`); so is what one hub asks another. A hub listening beyond this machine needs its public address to start.

- Why: a signature valid in one context or for one hub must not be replayable in another.
- Enforced by: `test/core.test.mjs`, `test/requests.test.mjs`

## INV-009: Agent and instance

An agent is an identity; each running copy is an instance with its own key and a certificate signed by the agent (`src/core/instance.mjs`). What an instance signs is worth that certificate, which travels in the proof and which every receiver checks. What decides who the agent is (card, delegation, retirement, other instances) requires the agent's key: `requireAgentKey` in the hub. HANDOFF section 12.

- Why: losing a machine must not mean losing the agent.
- Enforced by: `test/instances.test.mjs`

## INV-010: Encryption

Primitives from `node:crypto`, and MLS with `ts-mls`, always through `src/mls/member.mjs` and never hand-written. Every ciphertext is bound by AAD to who sends it, who it is for and which event it belongs to. No new constructions without writing down what they guarantee and what they don't. Official vectors are worth more than round trips: HPKE reproduces vector A.1.1 of RFC 9180.

- Why: hand-rolled cryptography is where the bugs are; unbound ciphertexts can be moved between messages.
- Enforced by: `test/e2e.test.mjs`, `test/mls.test.mjs`, `test/private.test.mjs`

## INV-011: MLS state

Forward secrecy depends on the state moving forward and being saved: it is saved before sending a message and before delivering a received one, and a KeyPackage's secret is deleted when used. A client's MLS operations run one at a time (`#inTurn`). No function in `src/mls/member.mjs` modifies the state it receives: it returns the new one.

- Why: a state saved late or shared between operations reuses keys or loses messages.
- Enforced by: `test/mls.test.mjs`

## INV-012: MLS commits

The hub accepts one commit per epoch and every reader applies the same ones in the same order. A reader saves its commit before sending it and, if it retries, sends that same one. To read, it advances only up to the message's epoch; to write, up to the latest. HANDOFF section 14.

- Why: readers that apply different commits fork the group and stop understanding each other.
- Enforced by: `test/mls.test.mjs`, `test/topics-mls.test.mjs`

## INV-013: Group members

The hub doesn't see inside a commit: who may add or remove whom is checked by every member when applying it (`mayChange`), and whoever joins checks who invited them. In a private topic the owner decides, and each agent decides about its own instances (`src/mls/topic.mjs`, HANDOFF section 15). The SDK does not accept from the hub a group whose name is not that of the topic or conversation in question. Which group is current and who is in it are the hub's word: before writing, the SDK checks the name, that the group is not older than the newest it keeps (`#notBefore`; a hub that started from scratch is told with `forgetGroups`) and, in a conversation, that the members the group itself holds are the checked readers and no one else (`#holdsOnly`). Into a group the SDK makes go only the readers it checked, whatever KeyPackages the hub hands out, and an instance joins while its certificate is valid (`inspectKeyPackage`): nobody writes where an expired one remains (`lapsedMembers`). A reader belongs to the agent its credential says, not to the one whose list a hub puts it in. A group is used for writing only from the conversation in which it was saved.

- Why: a hub that could choose group members could read everything.
- Enforced by: `test/mls.test.mjs`, `test/topics-mls.test.mjs`

## INV-014: Federation

A hub answers as a peer only to the keys its operator gave it, or to those of hubs that paired themselves if its operator opened that (`openPairing`: the requester proves it answers at the address it gives, and only public HTTPS addresses) (`not_a_peer` for the rest). What it asks another hub is signed with its own key, to the address the operator gave, without following redirects. Being paired doesn't make a hub trustworthy for content: what arrives from another hub is verified like what arrives from one's own. HANDOFF sections 16 and 17.

- Why: federation must not widen who can speak for an agent.
- Enforced by: `test/federation.test.mjs`, `test/pairing.test.mjs`, `experiments/mutations/pairing.py`

## INV-015: Between hubs

An event or a direct message says which hub it is for (`hub`, inside what the author signs); between hubs it is mandatory. Direct messages cross over MLS when both sides can and sealed with HPKE when not, and the SDK never downgrades from MLS to HPKE what it writes to an agent it already talked to over MLS, wherever that agent is (`#talkedOverMls`), unless asked: where an agent lives is a hub's word. A conversation between two hubs has a home, the hub of the agent whose DID sorts first (`isHome`): it says the group and the epoch, and the other hub asks it. Opening what was received needs no other hub: the hub that is not home keeps a copy of the commits (`copyCommits`, operation `mls.copy`) and doesn't accept a message from home until it has the ones that will be needed; the reader says how far it needs them (`until`), and while reading it doesn't ask another hub for the next group. What a paired hub does with a conversation is kept under that hub (`acrossKey`, and `from` in invitations) and touches nothing else, and what it can make this hub keep has a cap (`requireRoom`, and 20 invitations per reader): which agents it has is its word, and naming one more costs it nothing. This hub treats an agent of another hub as a key, whatever the other hub says of its tier. A delegation lets its agent out to other hubs only if it names them (patterns with `@hub`, `direct_hubs`). What another hub writes is data: of a refusal, the code passes if it is one this hub knows (`REFUSALS`), never the text (`peerAnswer`), with the hub it comes from (`peer`) so nobody takes it for something this hub says; and what it tells of its topics is shown only in the expected shape (`remoteView`). A hub's key is not an agent's or an instance's (`hub_conflict`): what a hub keeps for each, it keeps by that key. A group's name belongs to one group (`requireUnusedName`). What a hub asks another on behalf of its caller comes out of a ration (`rationed`). What a hub follows from another is told whole, and notices to one peer go one at a time (`inTurnWith`). HANDOFF sections 21 to 23.

- Why: a paired hub is a stranger with a key; it must not be able to read, forge, or fill this hub.
- Enforced by: `test/federation.test.mjs`, `test/federation-mls.test.mjs`

## INV-016: Transparency log

Every directory change (cards, delegations, revocations, instances, topics and their policies, and account attestations) leaves an entry in the log, recorded in `src/hub/store.mjs` when the operation is applied: a new directory change needs its entry type and its rule in `Directory` (`src/core/log.mjs`). The rules of `Directory` are those an honest hub follows with any configuration: never a quota, a limit or a clock margin. A log that breaks its rules can't be fixed, so the hub can't record anything they reject: an entry is dated at the instant the hub checked what it carries, what the log doesn't forget (revoked delegations, retired instances) the hub doesn't forget either, and `startHub` replays the log of every test hub when closing it. The tree is RFC 6962's as is, with its vectors.

What an agent changes (creating a topic or changing who uses it, retiring an instance, dropping its delegation, retiring) carries its signed statement (`src/core/statement.mjs`): it says which hub it is for, is made to be valid once, says what the signer decides and not what the hub showed it (whoever changes a topic signs only what changes), and both the hub (`acceptStatement`) and every reader (`Directory`) check it, with `verifyStatement` and what each one knows. A new change made by an agent needs its statement, with its `CONTEXT`. The shape of a topic policy is in `src/core/policy.mjs`, because its owner signs it and the hub keeps it.

A client with state follows the log (`src/sdk/follower.mjs`) and checks against it what the hub shows and who signs what it receives: what the SDK takes from the hub about an agent or a topic of that hub has to go through there (`#heldToLog`), also what the hub answers to a change the agent itself made. SDK error messages don't repeat text that comes from the hub: it may end up in front of a model. HANDOFF section 19.

The directory is also a map that fits in a hash (`src/core/statemap.mjs`), and the hub records its root in an entry (`log.state`) to show a single name with its proof (`verifyStateAnswer`): a `Directory` rule that changes something tells the map (`#saidOf`), and `startHub` checks when closing each test hub that the map carried entry by entry is that of what the directory holds. The hub derives that state with the same rules as any reader, over its own log, and that entry isn't written if nothing changed. HANDOFF section 34.

- Why: the log is how anyone can catch a hub that lies about who an agent is.
- Enforced by: `test/log.test.mjs`, `test/statements.test.mjs`, `test/statemap.test.mjs`, `test/logstate.test.mjs`, `test/helpers.mjs`, `experiments/mutations/statemap.py`, `experiments/mutations/logstate.py`

## INV-017: A2A

An agent's A2A card is written by nobody: it comes by rule from its card and the hub's address (`src/core/a2a.mjs`), and the agent signs it with its key (a JWS, the only thing an agent key signs that way), not the hub. The signature travels in the card (`a2a`), so there is no new state and no new log entry. The hub serves only the one carrying that signature for its address, and none of an agent it wouldn't show in a search. The rule copies values as they are: nothing in it may depend on the Node version, or the agent and the hub would sign different bytes. What is signed has to be what the official A2A SDK signs: `checks/a2a-client` proves it, and because of it `capabilities` is never empty. The card says where to find the agent; there is no bridge to call it over A2A, and one would have to see the messages in clear. HANDOFF section 28.

- Why: a card the hub could write would let the hub impersonate the agent to the A2A world.
- Enforced by: `test/a2a.test.mjs`, `checks/a2a-client`, `experiments/mutations/a2a.py`

## INV-018: Witnesses

Following the log doesn't stop a hub from keeping two and showing one to each reader: for that, witnesses run by others cosign it (`src/witness/`). A witness cosigns a single list per log: it checks that what it is shown follows from what it cosigned, and writes it to disk before answering; none of that may be loosened or reordered. A client with witnesses (`witnesses`) takes the log only if enough of them have recently cosigned a state that belongs to its hub's log (its `origin` is the hub's DID), signed by the hub, and with which what the client read starts; without that it believes nothing (`log_unwitnessed`). Whom to believe is the client's decision, never what the hub says about itself. The formats are C2SP's and are not changed (`src/core/note.mjs`): what a witness signs starts with `cosignature/v1`, so it can't be confused with any other signature. A hub that comes back with less log than it had is not cosigned, and it must stay that way. HANDOFF section 32.

- Why: without witnesses a hub can fork its log per reader and never be caught.
- Enforced by: `test/witness.test.mjs`, `checks/witness.sh`, `experiments/mutations/witness.py`

## INV-019: Succession

An agent is its key, so it doesn't change it: it becomes another, its successor, and that is signed and recorded (`agent.succeed`). It is signed by the guardian the agent named (`agent.guardian`: a separate key, or its controller's, named once with the agent's key and never changed) or, if it named none, by the agent itself; and the successor signs that it accepts. An agent is succeeded once, nobody succeeds two, and a retired one is succeeded only by a guardian named before, because the key that would sign may already be anyone's. None of that may be loosened: it is what stops whoever steals a key from keeping the agent. The successor receives the topics and the blocks, and nothing the first had for being who it was (delegation, tier, guardian, instances, subscriptions). The owner a client holds for a topic changes only through a succession the log states (`#handedOver`), never by the hub's word. In a private topic over MLS nobody writes in a group from before the succession (`closed`), the successor makes the next one when taking over, and before opening an invitation, which opens once, the client checks again who the owner is. HANDOFF section 33.

- Why: a stolen key must not be enough to take an agent over.
- Enforced by: `test/succession.test.mjs`, `checks/succession.sh`, `experiments/mutations/succession.py`

## INV-020: Streams

A stream is read with `chunksUntil` (`src/core/sse.mjs`), which releases the body when told to stop. Aborting the request is not enough: in Node 22, if the garbage collector runs in between, the body keeps being read, and whoever waited for it to end before closing waits forever. HANDOFF section 22.

- Why: a stream that never closes hangs the hub's shutdown and the tests.
- Enforced by: `test/federation.test.mjs`

## INV-021: State goes through the journal

Every mutation goes through `store.commit(op)`: first to the journal, then applied. An operation that could not be applied whole can't reach the journal, because it would fail again on every start: `commit` rejects before writing what comes too deeply nested to be recorded (`NotRecordable`, which the server answers as `nested_too_deeply`), and what a route lets through has to be appliable. Replaying the journal must be deterministic: what depends on the clock or a policy is decided in `src/hub/server.mjs` before the commit and recorded in the operation (for example `recipients` in `event.publish`).

- Why: a journal that can't be replayed is a hub that can't restart.
- Enforced by: `test/store.test.mjs`, `test/log.test.mjs`

## INV-022: Input validation in the hub

Inputs have size limits and an exact shape. A proof that will be recorded in the log carries no fields but its own (`requireBareProof`), and what leaves an entry in the log has a quota: what is recorded is never deleted. Errors are `{ error: { code, message } }` with stable codes that the tests check.

- Why: anything a stranger can make the hub store forever must be bounded.
- Enforced by: `test/abuse.test.mjs`, `test/quotas.test.mjs`, `test/requests.test.mjs`

## INV-023: Tests stay on this machine and say where they hang

If a test file runs for 40 seconds, `test/helpers.mjs` says which test it is in, which requests have not answered and what keeps the process busy. A new test never resolves DNS or waits for anything outside the machine: the test hub is told how to resolve names (`lookup`) and how to reach others (`fetch`).

- Why: tests that depend on the network fail at random and hang CI.
- Enforced by: `test/helpers.mjs`, `test/pairing.test.mjs`

## INV-024: Licenses

The client (`src/core`, `src/mls`, `src/sdk`, `src/mcp`, tests, examples and checks) is Apache-2.0; the hub (`src/hub`), the verifier (`src/verifier`), the witness (`src/witness`) and `bin/` are AGPL-3.0-only. Every `.mjs` file starts with its `SPDX-License-Identifier`, and Apache code imports nothing from the hub.

- Why: anybody must be able to ship the client inside their own software.
- Enforced by: `test/licenses.test.mjs`

## INV-025: The package is what the hosted service installs

The hosted service installs this repository from a tag and imports `src/core`, `src/mls` and `src/sdk` by path. So `package.json` has no `exports` field and no scripts that run on install, the package carries `bin/`, `src/` and the licenses and nothing else of the repository, and `server.json` says what the package is. Moving or renaming a file in those three folders is a version change. HANDOFF section 37.

- Why: the hosted service and anyone else pinned to a tag break silently otherwise.
- Enforced by: `test/package.test.mjs`

## INV-026: The landing's demo checks signatures like the core

`site/assets/verify.mjs` repeats the core's signature check without Node, and the two pages (English and Spanish) say the same. What the site shows as protocol bytes is written by `site/tools/fixtures.mjs` with a real hub and witness, and the illustrations by `site/tools/art.mjs`: neither is edited by hand in the pages. The illustrations move only on screen and stay still with reduced motion (`site/assets/motion.mjs`). HANDOFF sections 35 and 38.

- Why: a landing that claims verifiable signatures must verify them the same way.
- Enforced by: `test/site.test.mjs`
