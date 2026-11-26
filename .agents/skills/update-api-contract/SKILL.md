---
name: update-api-contract
description: Changes the lucid-kit protocol safely — HTTP routes and error codes, signing contexts, log entry types, journal operations, cross-hub requests, MLS names, A2A and OASF formats, MCP tools, CLI and the src paths the hosted service imports — classifying each change as additive or breaking and proving old data still works. Use whenever any of those changes.
---

# Update an API contract

## When

The plan adds, changes or removes anything listed under "Contract surfaces" in `docs/guides/api-contracts.md`.

## Read first

- `docs/guides/api-contracts.md`: surfaces, versioning, checks, consumers.
- `docs/invariants.md`: INV-008 (signatures), INV-015 (between hubs), INV-016 (transparency log), INV-021 (journal), INV-025 (package).
- The plan's "Interfaces" section, and the README's protocol section for the surface.

## Steps

1. List every surface the change touches. Classify each as additive or breaking (guide, rules 2 and 3).
2. Breaking: stop and ask the person whether it is a major version or a new context or route version next to the old one. Record the answer with `record-decision`.
3. A new signed statement type: its own `CONTEXT`, its check in the hub (`acceptStatement`) and in every reader (`Directory`). A new directory change: its log entry type and its rule in `Directory`, and what it tells the state map.
4. Change the code and its README section together. Error responses keep `{ error: { code, message } }` and stable codes.
5. Tests: the new behavior, the old behavior that must keep working, and the attacks (a statement replayed, signed for another hub, under another context). Use official vectors when a format has them.
6. Old data: run `checks/upgrade.sh` and the mixed-version checks (by hand with `AGENTHUB_OLD_TREE` until the version after 1.0.0; `checks/README.md`), and `node --test test/package.test.mjs`.
7. In the PR's Risk section, name each surface, the consumers it affects and the version bump it needs.

## Done when

- [ ] Every touched surface is listed in the PR, classified additive or breaking.
- [ ] Old journals, logs and checkpoints still replay and verify.
- [ ] Tests cover the old and new behavior and the attacks; the README matches the code.

## Don't

- Don't change what an existing `CONTEXT` covers, or how a recorded entry is applied.
- Don't move or rename files in `src/core`, `src/mls` or `src/sdk` without a version change.
- Don't pass another hub's text through; only its known codes.

## Improve this skill

If a step was wrong, missing or wasted effort, end your report with a proposed diff to this file. Don't apply it: harness changes need a person's review.
