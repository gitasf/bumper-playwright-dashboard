# Repository guidance

Wrightful is a Playwright reporting system. `@wrightful/reporter` streams test
results to a Void-based dashboard on Cloudflare. The dashboard stores auth,
tenancy, and test data in Postgres through Drizzle/Hyperdrive, stores artifact
bytes in R2, and broadcasts realtime progress through `void/ws` rooms.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the current system map.
Before substantive architecture work, also read
[`docs/worklog/void-migration-consolidated.md`](docs/worklog/void-migration-consolidated.md)
and
[`docs/worklog/2026-06-16-postgres-only.md`](docs/worklog/2026-06-16-postgres-only.md).
Worklogs before the Void migration describe the historical
rwsdk/Durable-Object/Kysely system and are not current guidance.

## Workspace

This is a pnpm workspace with `apps/*` and `packages/*`:

- `apps/dashboard` — `@wrightful/dashboard`, built with Void, Hono file-based
  routes, `@void/react` pages, Postgres/Drizzle, Better Auth, R2, queues, crons,
  and `void/ws`.
- `packages/reporter` — published Playwright reporter, built with `vp pack`.
- `packages/e2e` — demo Playwright suite, canonical dashboard Playwright suite,
  and a Vitest full-stack harness. Shared fixtures boot a real Void dashboard.

## Commands

```bash
pnpm install
pnpm setup:local
pnpm dev

pnpm build
pnpm test                                    # dashboard + reporter unit tests
pnpm --filter @wrightful/dashboard test
pnpm --filter @wrightful/reporter test
pnpm test:e2e                                # Vitest full-stack E2E harness
pnpm --filter @wrightful/e2e test:dashboard  # canonical dashboard Playwright suite

pnpm check                                   # format + lint + typecheck
pnpm check:fix
```

Run one test file with, for example:

```bash
pnpm --filter @wrightful/dashboard exec vitest run src/__tests__/schemas.workers.test.ts
pnpm --filter @wrightful/reporter exec vitest run src/__tests__/aggregation.test.ts
```

Database and deployment commands:

```bash
pnpm --filter @wrightful/dashboard db:generate       # generate committed Drizzle migrations
pnpm --filter @wrightful/dashboard db:migrate:remote # own-account remote Postgres
pnpm deploy:void                                     # Void-managed deployment
pnpm --filter @wrightful/dashboard deploy:cf         # own-account Cloudflare deployment
```

Do not hand-edit `apps/dashboard/wrangler.jsonc`; it is generated from
`wrangler.template.jsonc`. Void-managed deploys apply committed migrations.
Own-account deployments require the explicit remote migration command; see
`SELF-HOSTING.md`.

## Architecture guardrails

### Void application shape

- API handlers live in `apps/dashboard/routes/` and use Void/Hono
  `defineHandler`.
- Pages live in `apps/dashboard/pages/` as `*.tsx` views with co-located
  `*.server.ts` loaders/actions.
- Ordered cross-cutting middleware lives in `apps/dashboard/middleware/`.
- Use `void` and `@void/*` imports. The legacy rwsdk dashboard no longer exists.
- Void's generated types live under `apps/dashboard/.void/`. Run
  `void prepare` after a fresh install when codegen is missing; normal dev and
  build commands regenerate them.
- Declare environment variables in `apps/dashboard/env.ts` and read them from
  `void/env`. Treat that file as the authoritative env-var reference.

### Data and tenancy

- The sole application database is Postgres, accessed through Drizzle: import
  `db` from `void/db` and schema tables from `@schema`.
- Application schema lives in `apps/dashboard/db/schema.ts`; committed
  migrations live in `apps/dashboard/db/migrations/`.
- Better Auth owns `user`, `session`, `account`, and `verification`; do not add
  them to the application schema. Cross-table joins to them use raw SQL.
- Tenant isolation is logical, not a Durable Object boundary. Every run-scoped
  query must filter by branded `projectId` and by `teamId` where present.
- Tenant-scoped page loaders must call `requireTenantContext(c)` from
  `src/lib/tenant-context.ts`. It reuses the bundle resolved by
  `middleware/01.context.ts`.
- API-key flows use `tenantScopeForApiKey(...)`; session-backed APIs outside
  tenant middleware use `tenantScopeForUserBySlugs(...)`, both from
  `src/lib/scope.ts`. Do not cast arbitrary strings to authorization brands.
- Use `runBatch` for atomic multi-statement writes and `runRows` for raw reads.
  Preserve the Postgres numeric coercion conventions in `src/lib/db/`;
  node-postgres and pglite return some aggregate types differently.

### Auth, ingest, artifacts, and realtime

- Dashboard auth is Better Auth through `void/auth`; config lives in
  `apps/dashboard/auth.ts`.
- Ingest and query APIs use project-scoped Bearer keys through
  `middleware/02.api-auth.ts`. Do not assume every `/api/*` route uses the same
  auth: session-backed tenant APIs and MCP OAuth have separate paths.
- `X-Wrightful-Version` applies to ingest only. `/api/v1/*` is a versionless
  Bearer query/export contract, and `/api/mcp` negotiates JSON-RPC/MCP itself.
- Ingest routes are translation layers. The ownership → transaction → summary
  → activity → broadcast pipeline belongs in `apps/dashboard/src/lib/ingest.ts`.
- Keep `packages/reporter/src/types.ts` synchronized with
  `apps/dashboard/src/lib/schemas.ts`. The reporter contract test parses built
  reporter payloads through the dashboard schemas.
- Artifact bytes are worker-proxied by default. When all four optional R2
  S3-API credentials are configured, uploads and downloads use presigned R2
  URLs. Preserve both paths and their shared authorization/expiry rules; see
  ADR-0003 and `SELF-HOSTING.md`.
- Realtime uses only `void/ws` run and project rooms. Publish after successful
  writes through the helpers in `src/realtime/`; clients use `useRunRoom` and
  `useProjectRoom`. Do not reintroduce the removed rwsdk synced-state or SSE
  transports.

## Frontend conventions

- Pages are server-rendered, Inertia-style `@void/react` pages. Add
  `"use client"` only at interactive leaves.
- Check `apps/dashboard/src/components/ui/` before building a primitive. Page
  code must not import `@base-ui/react` or `@base-ui-components/react` directly.
- Use `@void/react`'s `Link` for internal navigation. Use plain anchors for
  external links and intentional island-page navigation.
- URL state uses `useSearchParam` for shallow client updates and
  `useNavigatingSearchParam` when loaders must rerun. Both live in
  `src/lib/hooks/use-search-param.ts`; nuqs is not part of the current application.
- Tailwind v4 tokens live in `apps/dashboard/src/styles.css`; there is no
  `tailwind.config.*`. Use `cn()` for merged or conditional classes.
- Reuse the shared status pills, metadata pills, tab bars, filter components,
  row links, empty states, pagination footer, date formatters, and focus-ring
  conventions already present in `src/components/` and `src/lib/`.
- In application code, prefer semantic tokens such as `text-foreground`,
  `text-fg-2/3/4`, `border-line-1`, and `bg-card`/`bg-bg-0/2/3`. Registry-owned
  `ui/` files may retain their shadcn-compatible aliases.

## Verification and worklogs

Run focused tests plus `pnpm check` for code changes. Run the relevant broader
suite for cross-package, database, routing, auth, realtime, or deployment work.
Before committing, `pnpm check` must exit successfully and the Vite+ pre-commit
hook must run; do not use `--no-verify`. Report checks that were not run.

Add `docs/worklog/YYYY-MM-DD-short-description.md` for architecture, schema,
dependency, deployment/configuration, authentication/tenancy, public protocol,
or substantial feature changes. Record what changed, why, notable migrations or
files, and verification. Routine small fixes and documentation corrections do
not need a standalone worklog unless they capture a non-obvious decision.

Use ULIDs for application-owned database primary keys.
