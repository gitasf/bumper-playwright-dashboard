# Security Policy

Thanks for helping keep Wrightful and its users safe.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **[Private vulnerability reporting](https://github.com/joefairburn/wrightful/security/advisories/new)**
(Security → Advisories → _Report a vulnerability_). If you can't use GitHub
advisories, open a minimal public issue that says only "security report — please
enable private reporting" with no details, and a maintainer will follow up.

Please include, where you can:

- what you found and the impact (e.g. cross-tenant read/write, auth bypass,
  token/secret exposure, RCE),
- a minimal reproduction (request/response, steps, or a small PoC),
- affected component (`apps/dashboard`, `@wrightful/reporter`), version/commit,
  and whether it's the hosted or a self-hosted instance.

We aim to acknowledge a report within a few business days and to keep you updated
as we investigate and fix. We'll credit reporters who want it once a fix ships.
Please give us a reasonable window to release a fix before any public disclosure.

## Scope

In scope: the dashboard app (ingest + artifact API, tenant-scoped UI, auth,
realtime), the Playwright reporter, and anything that could let one tenant read
or write another tenant's data, forge an API key or artifact token, or escape the
synthetic-monitor sandbox.

Out of scope: findings that require a pre-compromised host, self-inflicted
misconfiguration of a self-hosted instance, or best-practice suggestions with no
concrete exploit (open those as normal issues).

## Supported versions

This is an actively developed project; security fixes land on `main` and (for the
reporter) in the next npm release. There is no long-term-support branch — run a
recent `main` / the latest published `@wrightful/reporter`.

## Security model (context for reporters)

- **Tenant isolation is logical, enforced by the type system.** Every run-scoped
  query filters by `projectId` (and `teamId`); the branded `AuthorizedProjectId`
  makes a raw id un-passable. There is no per-team Durable Object boundary.
- **API keys** are SHA-256-hashed at rest, looked up by an 8-char prefix, then
  constant-time hash-compared.
- **Artifact download tokens** are HMAC-signed (carry the R2 key, so GETs never
  touch the DB); artifact bytes are served with a forced-attachment disposition
  and a content-type allowlist.
- **Ingest writes** to a terminal run are refused past an idle grace window, and
  the run `idempotencyKey` (a write-reopen credential) is never serialized to the
  client.

If you believe any of these guarantees can be bypassed, that's exactly the kind
of report we want.
