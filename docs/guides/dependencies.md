# Dependencies

How libraries, internal packages, tools and base images get in and stay current. Skills: `add-dependency` and `update-dependencies`.

## Project facts

| Fact | Value |
| --- | --- |
| Package managers and lockfiles | npm, `package-lock.json`. Separate lockfiles for `checks/mcp-client`, `checks/a2a-client` and `experiments/mls-interop`, which are not dependencies of the product |
| Workspace layout (internal libraries) | One package, no workspaces |
| Import boundaries and their check | Apache code doesn't import the hub (`test/licenses.test.mjs`); only `src/mls/member.mjs` imports `ts-mls` (`review-code`) |
| License allowlist | MIT, Apache-2.0, BSD, ISC: anything the Apache-2.0 client can ship |
| Release-age quarantine | 7 days, checked by hand: dependencies are few and exact |
| Automated updates | None. A new dependency needs the owner's approval and is named in the README (HANDOFF section 9) |

## Rules

1. Add, remove and upgrade only through the package manager. The lockfile is committed and never edited by hand.
2. CI installs from the exact lockfile and fails on a mismatch (`--locked`, `--frozen-lockfile`, `npm ci`…).
3. Every new dependency is justified in the PR: what it is for, alternatives considered (including writing it), license, maintenance and size.
4. Internal libraries are consumed as workspace packages, never copied. Shared code depends on nothing feature-specific: a `core` package never imports a module.
5. Minor and patch updates go in routinely. A major only after reading its breaking changes and searching the code for each one; check license, engines and peer dependencies again.
6. New releases wait the quarantine period before they are adopted, except security fixes. Transitive dependencies count too: when the quarantine is introduced or raised, re-resolve the lockfile (with pnpm: `pnpm clean --lockfile && pnpm install`).
7. Every override or resolution has a comment: who needs it and what breaks without it. Remove overrides that are no longer needed.
8. Fix vulnerabilities by upgrading the direct dependency first, then its parent; never force the lockfile.
9. Container base images are pinned by digest (`name:tag@sha256:…`).
10. No new managed cloud service or data store without a decision in `docs/decisions.md`.

## Checks

| Rule | Enforced by |
| --- | --- |
| Lockfile in sync (1, 2) | `npm ci` in `.github/workflows/ci.yml` |
| Known vulnerabilities (8) | OSV-Scanner in `.github/workflows/quality.yml` |
| Import boundaries (4) | `test/licenses.test.mjs` |
| Justification and license (3, 5) | `review-code`, `review-security` |
