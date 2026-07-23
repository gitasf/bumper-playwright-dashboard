# 2026-07-04–05 — Built-in MCP server (`/api/mcp`): tools, OAuth, dedup, coverage

Consolidates six worklogs from the MCP build-out (2026-07-04 server + pr/commit
filters; 2026-07-05 OAuth, `list_flaky_tests`, two code-quality dedup passes,
and a test-coverage sweep that caught a live bug).

## What shipped

A **Model Context Protocol server built into the dashboard** (`/api/mcp`,
Streamable HTTP, stateless) so coding agents (Claude Code, Cursor, VS Code, …)
can debug Playwright failures from Wrightful: look up tests by PR / commit /
branch, read full errors + retry history, view artifacts (small screenshots
inline as MCP image content; traces/videos via signed download URLs + a
`trace.playwright.dev` viewer link), and rank the flakiest tests.

**Tools** (all `readOnlyHint`): `list_runs`, `get_run`, `list_tests`,
`get_test_result`, `get_artifact`, `list_flaky_tests`. In OAuth/user mode a
`list_projects` tool is added and every scoped tool takes required `team` +
`project` args.

Auth is **hybrid**: project API key (`Authorization: Bearer <key>`, for
headless/CI) OR a **user-scoped OAuth 2.1 token** via the standard MCP OAuth
flow. En route the runs-list filter model gained **`pr`** (exact number) and
**`commit`** (4–40 hex SHA prefix) filters, which also land on the public query
API for free (`GET /api/v1/runs?pr=123&commit=abc1234`).

## Design decisions

- **In-app endpoint, not a sidecar package.** Serving MCP from the same worker
  means self-hosters get it with zero extra install, and tools call the lib
  layer directly (no HTTP self-round-trips). Same auth/rate-limit surface as
  `/api/v1/*`: `isQueryApiRoute` covers `/api/mcp`, so the Bearer gate
  (`middleware/02.api-auth.ts`) and the per-key `QUERY_RATE_LIMITER`
  (`03.rate-limit.ts`) apply unchanged. Deliberately **no** `X-Wrightful-Version`
  handshake — MCP negotiates its own version inside JSON-RPC.
- **Official SDK + `@hono/mcp` transport, stateless.** `@modelcontextprotocol/sdk`
  1.29 (zod v4) + `@hono/mcp` fetch-native Streamable HTTP on Workers. Each
  request builds a fresh `McpServer` + transport (`sessionIdGenerator: undefined`,
  `enableJsonResponse: true`) — no session affinity, every tool a self-contained
  read.
- **Tenant isolation is structural.** `buildMcpServer` closes over a
  `TenantScope`; every query goes through `src/lib/scope.ts` predicates. No tool
  argument can widen scope. In user mode `team`/`project` slugs resolve per call
  through `tenantScopeForUserBySlugs` (real membership join → branded
  `TenantScope`).
- **Bounded payloads.** `list_tests` truncates `errorMessage` at 2,000 chars
  (points at `get_test_result`); stacks cap 20,000; inline artifacts cap 2 MiB
  (images, under Claude's ~5 MB base64 limit) / 128 KiB (text). Everything else
  returns a short-lived HMAC-signed download URL (`signArtifactToken`, no auth
  header) an agent can hand to `curl` / `npx playwright show-trace`.
- **`commit` filter is a prefix** `ILIKE 'sha%' ESCAPE '\'` (index-friendly,
  no leading wildcard) because agents hold short SHAs while the reporter records
  the full 40. Hex-validated at parse AND escaped at the WHERE builder.

### OAuth (Better Auth `mcp` plugin)

- Plugin brings the whole OAuth 2.1 provider: dynamic client registration,
  authorize/token endpoints, discovery, `getMcpSession`. Its three tables
  (`oauthApplication` / `oauthAccessToken` / `oauthConsent`) flow through void's
  Better Auth schema bootstrap automatically. `better-auth` is now a direct
  dashboard dep purely for this import.
- **Consent is FORCED server-side.** The plugin auto-issues codes to any
  signed-in browser unless the client sends `prompt=consent` (MCP clients
  don't) — with open dynamic registration that is a silent-grant hole.
  `middleware/02.api-auth.ts` 302s every `/api/auth/mcp/authorize` missing
  `prompt=consent` back onto itself with it set; `pages/oauth/consent.tsx`
  renders approve/deny. **Do not remove this leg.**
- **`requirePKCE: true`** (every MCP client is public). **Expiry checked by us**:
  `getMcpSession` returns the raw token row without validating
  `accessTokenExpiresAt`, so `requireMcpAuthOrResponse` (`src/lib/api-auth.ts`)
  enforces it (unparsable expiry fails closed).
- **Discovery at origin root** via `void.json` `routing.rewrites`:
  `/.well-known/oauth-{authorization-server,protected-resource}` (+ RFC 9728
  `…/api/mcp` variants) rewrite onto the plugin's `/api/auth/.well-known/*`.
  OAuth-authed requests key the rate limiter by `mcpAuth.userId`.

### Code-quality dedup (no behavior change)

Two review-driven passes folded the new MCP query layer onto canonical shared
code so it can't drift:

- **`paginateRunTests` + `runTestsOrderBy`** (`run-results-page.ts`) — generic
  engine owning the owner probe, status/cursor WHERE, `(createdAt, id)` DESC
  tuple, and slice/nextCursor unwrap once. `loadRunResultsPage` (4 other
  consumers) and MCP's `loadMcpRunTests` are now thin projection+mapper wrappers.
- **`loadTestResultChildren`** (`src/lib/test-result-children.ts`) — the shared
  tags/annotations/per-attempt-error batch, reused by the run test-detail page
  loader and MCP. Still fired concurrently by each caller.
- **`rankFlakyTests` + `RankedFlaky`** (`src/lib/analytics/flaky-ranking.ts`) —
  the flaky ranking pass (synthetic-traffic exclusion via `ciRunsJoinOn()`,
  status counters, `flaky/(flaky+passed)` rate, rate-then-count sort) now has
  one owner. The flaky page and MCP's `loadMcpFlakyTests` decorate the same
  ranked slice with their own second pass — identical by construction. Returns
  the unrounded rate so the sort tiebreak is exact; callers keep own rounding.
- **`get_run` → `loadMcpRun`** — moved the last inlined SQL out of `server.ts`,
  which is back to pure tool-definition + URL-shaping.

### Live bug caught by the coverage sweep

`routes/api/mcp/index.ts` wired GET/DELETE to the same `@hono/mcp` transport as
POST, on the (wrong) assumption it answers the spec's 405. The transport's GET
handler instead opens a **standalone SSE stream with a 30s keepalive loop** — on
our stateless server an eternal hanging response any key-holder could leave
dangling, one occupied Workers request each. Fixed by answering GET/DELETE with
405 (`Allow: POST`, JSON-RPC error body) in the route itself, as
`docs/api/mcp.md` documented.

## Details

| Item         | Value                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| New deps     | `@modelcontextprotocol/sdk` ^1.29, `@hono/mcp` ^0.3, `better-auth` ^1.6.11 (direct; was transitive) — dashboard  |
| New route    | `routes/api/mcp/index.ts` (POST; GET/DELETE → 405)                                                               |
| New lib      | `src/lib/mcp/{server,queries}.ts`, `src/lib/analytics/flaky-ranking.ts`, `src/lib/test-result-children.ts`       |
| Reworked lib | `run-results-page.ts` (+`paginateRunTests`/`runTestsOrderBy`), `api-auth.ts` (`requireMcpAuthOrResponse`)        |
| auth.ts      | `mcp({ loginPage: "/login", oidcConfig: { requirePKCE, consentPage: "/oauth/consent" } })`                       |
| New page     | `pages/oauth/consent.tsx` + `consent.server.ts`                                                                  |
| Middleware   | 02: `forceConsentRedirect` + `requireMcpAuthOrResponse` (key OR token, 401 + `WWW-Authenticate`); 03: userId key |
| Predicates   | `isMcpRoute` (subset of `isQueryApiRoute`); `RunsFilters` + `pr`/`commit` (parse → WHERE → toSearchParams)       |
| void.json    | `routing.rewrites` for the four root `.well-known` paths                                                         |
| Docs         | `docs/api/mcp.md` (new), `docs/api/query-export.md` (pr/commit params)                                           |

## Verification

- **e2e** (`packages/e2e/src/e2e.test.ts`, live dashboard + Postgres 16, 26/26):
  raw JSON-RPC over HTTP — 401 on bad key, `initialize`/`tools/list`, full
  `list_runs → list_tests → get_test_result` walk over reporter-seeded data,
  `list_flaky_tests` ranks the deliberately-flaky demo test then round-trips its
  `lastFlakyTestResultId` through `get_test_result`, `get_artifact` inline-text
  - trace-metadata (signed URL fetches exact bytes with no auth header),
    commit/branch filters, GET/DELETE→405, and the full programmatic OAuth dance
    (root discovery, dynamic registration, authorize→forced consent→code, PKCE
    exchange, minted token driving the tools; non-member team errors; consent
    denial → `error=access_denied`, no code).
- **Deterministic seeded VCS context** (`vitest.globalSetup.ts`): pins the
  seeding run to branch `e2e-seeded-branch`, commit `e2e5eedc0ffee…` (40 hex),
  actor `e2e-bot`, with empty `GITHUB_HEAD_REF`/`GITHUB_EVENT_PATH` to defeat
  PR-event detection; exposed via `inject("seededBranch"/"seededCommitSha")`.
  The demo suite gains a `retries: 1` fail-then-pass test (a real `flaky` row)
  for dogfooding + deterministic e2e — comment tells maintainers not to "fix" it.
- **Unit**: `mcp-server` (protocol contract via real SDK client over in-memory
  transport), `mcp-auth` (expiry fail-closed, WWW-Authenticate, key-first
  short-circuit), `runs-filters-pr-commit`, `rate-limit` (userId keying),
  `ingest-routes` (`/api/mcp` classifies as query surface). Dashboard + reporter
  suites pass.
- `pnpm check` clean (0 errors); `pnpm build` (workerd bundle incl. MCP SDK)
  succeeds; typecheck clean.

## Deliberately not added

- Positive **pr-number** filter e2e (needs a fake `GITHUB_EVENT_PATH` payload;
  WHERE logic is unit-tested in `runs-filters-pr-commit.workers.test.ts`).
- Refresh-token grant coverage (better-auth plugin internals, not our code).
