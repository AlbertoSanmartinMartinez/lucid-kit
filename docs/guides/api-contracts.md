# API contracts

How the protocol changes without breaking agents, hubs, witnesses or the hosted service. Skill: `update-api-contract`.

lucid-kit has no OpenAPI file: its contract is the set of bytes other parties sign, store and parse. Everything below counts as contract.

## Project facts

| Fact | Value |
| --- | --- |
| Contract surfaces | 1. HTTP routes, bodies and error codes (`README.md`, section "API HTTP"; `src/hub/server.mjs`). 2. Signing contexts: one `CONTEXT` per signed statement type, `agenthub/…/vN` (`src/core/*.mjs`), and the request signature `agenthub/request/v2` (`src/core/reqsig.mjs`). 3. What is recorded forever: transparency log entry types and their rules (`src/core/log.mjs`), journal operations (`src/hub/store.mjs`), C2SP checkpoints and cosignatures (`src/core/note.mjs`). 4. Cross-hub requests and refusal codes (`REFUSALS`). 5. MLS group names and credentials (`src/mls/`). 6. The A2A card and OASF record (`src/core/a2a.mjs`, `src/core/oasf.mjs`). 7. MCP tools (`src/mcp/server.mjs`) and CLI commands (`bin/agenthub.mjs`). 8. File paths in `src/core`, `src/mls` and `src/sdk`, which the hosted service imports |
| Versioning scheme | The package version (semver tag `vX.Y.Z`) for everything; plus a version inside each signing context (`/v1`, `/v2`) and route prefix (`/v1/`) |
| Breaking-change detector | No automatic detector. `test/package.test.mjs` (package shape and paths), the official vectors in `test/`, and the version checks in `checks/`: `upgrade.sh` (new code over old data and journal), `mixed-hubs.sh` and `mixed-clients.sh` (old and new side by side). Until the version after 1.0.0 they run by hand with `AGENTHUB_OLD_TREE` (`checks/README.md`) |
| Known consumers | Agents on older SDK or CLI versions; paired hubs on other versions; witnesses; the hosted service (private repository, pinned to a tag); the landing's `site/assets/verify.mjs`; MCP clients; A2A and OASF readers |
| Deprecation window | None yet: a breaking change is a major version, announced in the release notes |

## Rules

1. The contract is reviewed like code: the PR names every surface it touches.
2. Additive changes don't break: a new route, a new optional field, a new error code, a new statement type with its new `CONTEXT`, a new log entry type with its rule in `Directory`.
3. These break: removing or renaming a route, field or error code; changing what an existing `CONTEXT` covers; changing how an existing log entry or journal operation is applied; moving or renaming a file in `src/core`, `src/mls` or `src/sdk`; changing a C2SP format. A breaking change needs a major version, or a new context or route version that lives next to the old one.
4. What is already recorded must stay readable: a new version replays old journals and verifies old logs and checkpoints. `checks/upgrade.sh` proves it.
5. A signed format never changes meaning under the same context: a new meaning gets a new context (INV-008).
6. Errors keep the shape `{ error: { code, message } }` and stable codes, which tests check (INV-022). Another hub's codes pass only if they are in `REFUSALS` (INV-015).
7. Official vectors (RFC 9180, RFC 6962, C2SP, the official A2A SDK) are the test of a format, not a round trip.
8. The README's protocol section and `docs/architecture.md` change in the same PR as the contract.

## Checks

| Rule | Enforced by |
| --- | --- |
| Package paths and shape (3) | `test/package.test.mjs` |
| Old data still works (4) | `checks/upgrade.sh`, `checks/mixed-hubs.sh`, `checks/mixed-clients.sh` |
| One context per meaning (5) | `test/core.test.mjs`, `review-code` |
| Stable error codes (6) | `test/requests.test.mjs`, `test/abuse.test.mjs` |
| Official vectors (7) | `test/e2e.test.mjs`, `test/log.test.mjs`, `checks/a2a-client` |
