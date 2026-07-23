# 2026-04-16 — Establish Wrightful product identity

## What changed

The pre-launch project identity was standardized as **Wrightful** across every
public and internal surface. The npm scope, CLI binary, Cloudflare resources,
environment variables, protocol header, configuration namespace, tests, and
documentation were aligned in one sweep. The product domain is
`wrightful.dev`.

## Details

| Surface               | Established identity               |
| --------------------- | ---------------------------------- |
| Packages              | `@wrightful/*`                     |
| CLI and config        | `wrightful`, `.wrightfulrc`        |
| Environment variables | `WRIGHTFUL_*`                      |
| Protocol header       | `X-Wrightful-Version`              |
| Cloudflare resources  | `wrightful`, `wrightful-artifacts` |
| Display name          | Wrightful                          |

The package manifests, CLI configuration and logging, dashboard API
middleware, artifact storage configuration, GitHub Action, E2E setup, CI
workflow, examples, tests, and project documentation were updated together so
there was no compatibility period or split identity to maintain.

## Deployment notes

No published packages or live Cloudflare resources existed at the time, so no
data or compatibility migration was required. Local Wrangler state could be
regenerated on the next development-server start.

## Verification

- `pnpm install` completed with an unchanged lockfile.
- `pnpm lint` completed without errors.
- `pnpm typecheck` passed.
- `pnpm test` passed (126 tests at the time).
- The CLI and dashboard builds completed successfully.
- Wrangler types regenerated cleanly.

E2E was deferred until the local Cloudflare resources were bootstrapped under
the finalized identity.
