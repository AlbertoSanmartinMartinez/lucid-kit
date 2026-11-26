# Metrics

Definitions, not dashboards. A metric is used in specs and reviews only if it is defined here.

## Engineering

| Metric | Definition | Source |
| --- | --- | --- |
| Lead time | From first commit on a branch to merge into `main` | Forge API |
| Change failure rate | Share of releases that need a rollback or hotfix | Releases and incident log |
| First-pass CI | Share of PRs whose first ready run of CI is green | Forge API |
| Review findings per PR | Blocking and important findings from `review-code` and `review-security` | PR comments |
| Agent tokens and cost per PR | Tokens and cost the agents spent on a PR, from the agent's usage report or the model gateway | Agent telemetry or gateway logs |

Baseline: None yet. Measure the same small change made with and without the harness, with its tokens and cost.

## Product

| Metric | Definition | Source |
| --- | --- | --- |
| Tests | Number of tests in `npm test` (290 at 1.0.0) and mutants caught by `experiments/mutations/` (149 of 149 on 2026-11-16) | `npm test`, the mutation scripts |
| Activation | None yet: defined with the public sandbox hub (ALB-349) | |
