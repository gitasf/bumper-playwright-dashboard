# Security guidance for the Wrightful dashboard

Wrightful is a multi-tenant Playwright reporting system on Void/Cloudflare.
Tenant isolation is **logical**, not a runtime boundary — every data-access
mistake is a cross-tenant leak. Weight tenancy, auth, and secret-handling
findings accordingly. Function/file names below are in `apps/dashboard`.

## Tenant isolation (highest priority)

- Every run-scoped query MUST filter by a branded `projectId`. Flag any query
  over `runs`, `testResults`, `testResultAttempts`, `testTags`,
  `testAnnotations`, `artifacts`, `monitors`, `monitorExecutions`, or
  `quarantinedTests` that lacks a project filter.
- Exception: trusted fleet-wide maintenance runs from crons/queues (e.g. the
  stale-run sweep via `staleRunFilter`, the monitor scheduler's `dueMonitorsWhere`
  select) deliberately enumerate rows across projects, then apply per-row scope
  before any mutation. Do NOT flag these cross-project SELECTs as leaks. Instead
  verify they run only from a cron/queue handler (not a user-facing route),
  expose no tenant data in a response, and scope their writes per row.
- List/aggregate queries over `runs` additionally AND `teamId` (via
  `runScopeWhere` / `ciRunsScopeWhere`) for defense-in-depth. A lookup keyed by
  a globally-unique ULID — a single run by `id`, or a child row by its own
  primary key — is correctly scoped by `projectId` ALONE (`runByIdWhere`,
  `childByIdWhere`); the id cannot belong to another project, so do NOT flag
  these for missing `teamId`.
- The ONLY sanctioned way to turn a raw string into a branded
  `AuthorizedProjectId` / `AuthorizedTeamId` is `makeTenantScope(...)` in
  `src/lib/scope.ts`. Flag any `as AuthorizedProjectId`, `as AuthorizedTeamId`,
  or other cast that launders an unchecked string into a scope outside that
  function.
- Prefer the blessed scope predicates (`runScopeWhere`, `runByIdWhere`,
  `childProjectScopeWhere`, `childBy*Where`, `ciRunsScopeWhere`) over
  hand-rolled `eq(table.projectId, ...)`. Scope a child table by its OWN
  `projectId` column — never by joining back through `runs`.
- Tenant-scoped page loaders under `/t/:teamSlug/p/:projectSlug/*` must resolve
  scope via `requireTenantContext(c)` (`src/lib/tenant-context.ts`). Session
  APIs outside that middleware use `tenantScopeForUserBySlugs(...)`; API-key
  ingest uses `tenantScopeForApiKey(...)`. Flag a loader/handler that reads
  tenant data from a raw slug/id in the URL without going through one of these.
- When a team/project is missing OR the user is not a member, return `null` → 404. Do not distinguish "not found" from "forbidden" — that leaks existence.

## Auth and API surfaces

- Better Auth owns `user`, `session`, `account`, `verification`. Do not add
  those tables to `db/schema.ts`; cross-table joins to them use raw SQL only.
- Ingest and query APIs authenticate with project-scoped Bearer keys via
  `middleware/02.api-auth.ts`. Do not assume every `/api/*` route shares one
  auth model: `/api/t/*` is session auth, `/api/mcp` is OAuth/API-key,
  artifact download is a signed token. Auth for the Bearer surfaces is
  centralized in `02.api-auth.ts`, so a correctly-wired ingest/query handler has
  NO handler-local check — it just calls `getApiKey(c)` then
  `tenantScopeForApiKey(...)`. Before flagging a route as unauthenticated, check
  that the middleware's route matcher (`isIngestRoute` / `isQueryApiRoute` in
  `src/lib/ingest-routes.ts`) actually covers its path; flag only when the path
  falls OUTSIDE the matcher yet reads tenant data.
- The MCP OAuth authorize path forces `prompt=consent` (`forceConsentRedirect`)
  to stop drive-by token minting for signed-in users. Do not remove or weaken
  that redirect, and keep dynamic client registration paired with the consent
  screen.
- Do not weaken or bypass the pre-auth IP rate-limit backstop or the per-key
  limiter in `03.rate-limit.ts`; failed-auth attempts must stay bounded.
- API keys must be stored/compared as hashes, never logged or returned in
  responses. Use constant-time comparison for tokens/HMACs, not `===`.

## Artifacts

- Artifact download is authorized by a signed HMAC token in `?t=`, NOT by
  Bearer keys. Preserve the token's signature check and expiry on BOTH the
  worker-proxied path and the presigned-R2 path. Do not serve artifact bytes
  from a path that skips the token check.

## Secrets, logging, and injection

- Declare every env key in `apps/dashboard/env.ts` and read via `void/env`.
  Never hardcode credentials, keys, or connection strings. Only `VITE_*` keys
  may reach client code — flag a secret exposed under a `VITE_` prefix or
  bundled into a client island.
- Never log secrets, API keys, Bearer tokens, session cookies, or full DB
  connection strings. Route app errors through `void/log` `logger.*`.
- Raw SQL (`runRows`, `runBatch`, `sql` fragments) must be parameterized. Flag
  any string-interpolated user/tenant input in a SQL statement.
- Server-rendered React: flag `dangerouslySetInnerHTML` and any unsanitized
  user/test-supplied content (test names, error messages, annotations, artifact
  paths) rendered as HTML or used in a redirect `Location`.

These are guidance for the reviewer, not hard guardrails — surface violations
as findings to fix.
