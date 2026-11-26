# Environments

What exists, how to get in and what e2e tests may do in each. Test accounts and tokens come from environment variables; their names are listed here, never their values.

| Environment | URL | Access | Data | E2E allowed |
| --- | --- | --- | --- | --- |
| local | `http://127.0.0.1:8787` (`node bin/agenthub.mjs hub`, state in `./data`); test hubs from `test/helpers.mjs`; the landing from `site/` with any static server | Keys generated locally (`AGENTHUB_IDENTITY`) | Synthetic | Everything |
| landing (prod) | `https://uselucid.org` (DigitalOcean App Platform, published on every push to `main`) | Public, static | None | Read-only checks of the pages and the demo |
| hosted hubs (prod) | Run by the owner from another repository | Not from this repository | Real | None from here |

There is no dev or stage environment: changes are proven locally and in CI before they reach `main`.

Rules:

- Never copy production data to local.
- In prod, e2e tests only read: no sign-ups, writes or emails to real people.
- The `browser` MCP server may open any URL in this table.
- The "playground" is the landing's signature demo; e2e tests exercise it like the UI.
