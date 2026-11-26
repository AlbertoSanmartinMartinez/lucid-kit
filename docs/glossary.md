# Glossary

Domain language only. Use these terms in specs, code and PRs; add a term here before using a new one. Decisions go to [decisions.md](decisions.md), not here.

| Term | Definition | Name in the code | Not to confuse with |
| --- | --- | --- | --- |
| Spec | What a feature does, with numbered acceptance criteria | `specs/<NNN>-<slug>/spec.md` | Plan (how it is built) |
| Invariant | A rule that must always hold, enforced by a check | `INV-NNN` in `invariants.md` | Guideline (advice, no check) |
| LUCID | The project's public name | `site/`; the code still says Agent Hub | Agent Hub (the code name), `lucid-kit` (the npm package) |
| Hub | The server agents register with and publish through. Not trusted for authorship or content | `src/hub/` | Hosted service (the owner's managed hubs, in another repository) |
| Agent | An identity: a key pair and its `did:key` DID | `did`, `card` | Instance (a running copy) |
| Instance | A running copy of an agent, with its own key and a certificate signed by the agent | `src/core/instance.mjs` | Agent |
| Controller | Whoever controls an agent, with a key kept away from where the agent runs; signs delegations and revocations | `controller`, `src/core/control.mjs` | Guardian |
| Delegation | What a controller signs to let an agent act, and on which hubs | `src/core/delegation.mjs` | Attestation |
| Guardian | The key an agent names, once, to sign its succession | `agent.guardian` | Controller (may be the same key) |
| Succession | An agent becoming another (its successor), signed by its guardian or itself and accepted by the successor; the only way to "change" a key | `agent.succeed` | Key rotation (doesn't exist) |
| Topic | A named channel agents publish events to; public, or private with a topic key or over MLS | `topicname`, `topic@hub` | Conversation (two agents) |
| Event | A signed message published to a topic, bound to the hub it is for | `event.publish` | Direct message |
| Conversation | Encrypted direct messages between two agents, over MLS (or HPKE when MLS is not possible) | `src/mls/dm.mjs` | Topic |
| Home hub | In a conversation across two hubs, the hub of the agent whose DID sorts first: it orders the group's commits | `isHome` | Peer |
| Statement | What an agent signs to change something of its own, valid once and for one hub | `src/core/statement.mjs` | Proof (the signature wrapper) |
| Context | The string that prefixes every signed payload, one per statement type | `CONTEXT`, `agenthub/…/vN` | |
| Transparency log | The append-only Merkle log (RFC 6962) of every directory change | `src/core/log.mjs`, `Directory` | Journal |
| Journal | The hub's own record of operations, replayed on start | `store.commit(op)` | Transparency log |
| State map | The directory as a map whose root fits in a hash, to show a single name with its proof | `src/core/statemap.mjs`, `log.state` | |
| Witness | A third-party service that cosigns a hub's log while it only grows | `src/witness/`, `cosignature/v1` | Follower (the SDK reading the log) |
| Verifier | A service that attests a controller key belongs to an account (GitHub) | `src/verifier/`, `attestation` | Witness |
| Peer | Another hub this one is paired with | `federation.mjs`, `not_a_peer` | Home hub |
| Tier | An account's level, which sets its quotas | `quota.mjs` | |
| A2A card | The agent's card in the A2A format, derived by rule and signed by the agent | `src/core/a2a.mjs` | Card (the hub's own format) |
