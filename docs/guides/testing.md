# Testing

What is tested where, with which data, and what to do with flaky tests. Skills: `write-tests` and `run-e2e-tests`.

## Project facts

| Fact | Value |
| --- | --- |
| Unit and integration frameworks | `node:test` and `node:assert`, no dependencies. Integration tests start real hubs in the same process (`test/helpers.mjs`) |
| E2E framework | `npm run demo`, and the shell checks in `checks/` with real processes (`checks/README.md`). The landing: `test/site.test.mjs` and the `browser` MCP server |
| Where tests live | `test/<area>.test.mjs`; mutation scripts in `experiments/mutations/` |
| Diff coverage target | No percentage: every defense has a test that fails without it, proven by the area's mutation script |
| Quarantine mechanism | None: a flaky test is fixed, not skipped. `test/helpers.mjs` reports where a file hangs after 40 seconds |

## Levels

| Level | Proves | Dependencies |
| --- | --- | --- |
| Unit | Logic and rules | In-memory fakes for ports; no I/O |
| Integration | Hub, SDK and federation together | Test hubs from `test/helpers.mjs`, with injected `lookup` and `fetch` |
| E2E | User journeys and the playground, per acceptance criterion | A running environment (`docs/environments.md`) |

## Rules

1. Every acceptance criterion (`AC-n`) has a test at the lowest level that proves it; e2e only for journeys.
2. A new test is seen failing before it passes. A test never seen failing does not count.
3. Tests are independent and safe to run in parallel: no shared state, no order, no real network in unit tests, an injected clock.
4. Assert outcomes, not implementation details.
5. Data is synthetic: keys generated per test and fixtures. Never real personal data or production copies (`docs/guides/privacy.md`).
6. Changed lines meet the diff coverage target, or the PR explains the gap.
7. A flaky test is quarantined with a tracker item and a deadline, never retried into green. Quarantine is not deletion.
8. Don't delete or weaken a failing test to make a change pass; explain why it is wrong.
9. Integration tests that call a handler function directly skip the routing layer (middleware, proxies, rewrites). Every API route gets at least one test through the real server, usually an e2e.

## Checks

| Rule | Enforced by |
| --- | --- |
| Tests pass for changed paths | CI, `verify-changes` |
| Diff coverage (6) | `experiments/mutations/`, `review-code` |
| Criteria covered (1) | `review-code`, the PR's Evidence section |
