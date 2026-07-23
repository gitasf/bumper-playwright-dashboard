# 2026-07-15 — MCP OAuth discovery: rewrite `.well-known/*` in-worker

## What changed

MCP OAuth discovery was broken in production: a client connecting to
`https://dash.wrightful.dev/api/mcp` with no credentials got the correct
`401 WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"`
challenge (RFC 9728), but fetching that root URL returned **404** — so no MCP
client could discover the authorization server and the OAuth 2.1 flow never
started. `claude mcp list` showed the server reachable but unauthenticatable.

## Root cause

Discovery depended on the four `routing.rewrites` in `apps/dashboard/void.json`
that map the origin-root `.well-known` paths onto Better Auth's
`/api/auth/.well-known/*` handlers. Those are **edge rules**, and **void 0.10.4
does not apply them in the deployed Cloudflare worker**. Verified against live
production (`441dfd1`, the current deploy — not a stale build):

- `POST /api/mcp` → 401 with the correct `WWW-Authenticate` challenge ✅
- `/.well-known/oauth-protected-resource` → **404**, and the body is the
  **not-found HTML page** (identical to a random unmatched path) — i.e. the
  request reached the Hono router _unrewritten_, matched no route, and fell
  through to `00.errors.ts`'s not-found rewrite. The edge rewrite never fired.
- `/api/auth/.well-known/oauth-protected-resource` (the rewrite _target_) →
  **200** with a valid document. Better Auth's `mcp` plugin is healthy; only the
  root→`/api/auth` hop was missing.

The `vp dev` e2e OAuth dance passed because the dev server _simulates_ the edge
rewrite; production's edge layer does not. So CI was green while prod was broken.
The whole `void.json` `routing` block is inert in prod (the `/* → /not-found`
fallback also doesn't fire — `00.errors.ts` is what actually renders not-found).

## Fix

`apps/dashboard/middleware/00.oauth-discovery.ts` — a middleware that performs
the same four-path rewrite **in-worker** with `c.rewrite()` (the mechanism
`00.errors.ts` already uses for `/not-found` and `/oops`). It runs at `00.*`
(before `01.context.ts`, so an unauthenticated discovery fetch short-circuits
before the tenant-bundle DB read) and inside the `00.errors.ts` gate. The
rewrite target is not itself a mapped key, so the re-dispatch cannot loop.

This is deploy-method-agnostic and — unlike the edge rule — is exercised by the
actual worker, so the workers test lane covers it. The `void.json` rewrites are
**kept** as a redundant edge path in case a future void release honors them;
the two mappings must stay in sync.

## Files

- `apps/dashboard/middleware/00.oauth-discovery.ts` — new; `DISCOVERY_REWRITES`
  map + `resolveDiscoveryRewrite()` + the middleware.
- `apps/dashboard/src/__tests__/oauth-discovery-rewrite.workers.test.ts` — new;
  mapping table (incl. no-loop / non-discovery cases) + middleware short-circuit.
- `apps/dashboard/routes/api/mcp/index.ts` — doc comment updated: discovery is
  now rewritten in-worker, with `void.json` as a redundant edge mapping.

## Verification

- New test: 10/10 pass (`vitest.workers.config.ts`).
- MCP/middleware workers tests together: 26/26 pass.
- `pnpm check`: 0 errors (139 warnings all pre-existing in
  `packages/reporter/src/client.ts`, untouched here).
- Not yet re-verified against a live redeploy — after deploy, confirm
  `curl -s -o /dev/null -w '%{http_code}' https://dash.wrightful.dev/.well-known/oauth-protected-resource`
  returns **200** and returns JSON (not the not-found HTML).

## Follow-ups

- The e2e OAuth dance runs against `vp dev`, which masks edge-vs-worker
  behavior differences; the new workers test closes that specific gap but the
  e2e still can't catch an edge-only regression.
- If void restores `routing.rewrites` behavior in a later release, the
  `void.json` mapping and this middleware are redundant but harmless.
