# Privacy and data

How personal and confidential data is handled in code, tests, logs and Git. Applied by the Definition of done and `review-security`; no skill of its own.

## Project facts

| Fact | Value |
| --- | --- |
| Personal data the product stores | The hub: agent DIDs and cards, topic names and descriptions, IP addresses in rate limits (memory only), and account attestations, which name an account only by an opaque reference. The verifier: the GitHub account it attests, while the flow runs. Message bodies are end-to-end encrypted and the hub can't read them |
| Retention | The transparency log is append-only: what is recorded is never deleted, so personal data never goes into a log entry. Everything else lives as long as the hub's journal |
| Regulations that apply | GDPR, for the hosted service and the landing's contact address |
| Who handles data requests | The owner, for uselucid.org and the hosted service; the operator, for a self-hosted hub |

## Rules

1. Keep the inventory above current: a new personal field is added here in the same PR, with its purpose.
2. Collect only what the feature needs; delete it when the retention period ends.
3. Tests, seeds, fixtures and screenshots use synthetic data only.
4. Production data is never copied to local, dev or stage, not even "just to debug".
5. Logs, traces, metrics labels and error reports carry no personal data beyond opaque ids.
6. No customer names, personal data or internal hostnames in any Git text: commits, branches, PR and issue text, docs, test names. Use neutral replacements (`customer-a`, `user@example.test`).
7. Access to personal data goes through the same authorization as any other resource; no debug back doors.

## Checks

| Rule | Enforced by |
| --- | --- |
| Synthetic data (3, 4) | `review-security`, `docs/environments.md` |
| No personal data in logs (5) | `review-security`, `docs/guides/observability.md` |
| Confidentiality in Git (6) | `review-code`, `review-security` |
