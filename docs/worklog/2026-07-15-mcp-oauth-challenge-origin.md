# 2026-07-15 — Pin the MCP OAuth challenge to the public origin

## Symptom

An unauthenticated request to `https://dash.wrightful.dev/api/mcp` returned a
`WWW-Authenticate` challenge whose `resource_metadata` URL began with
`http://dash.wrightful.dev`. MCP clients could not use that insecure URL to
start OAuth discovery reliably.

## Root cause

`mcpUnauthorized` built the metadata URL from `c.req.url`. As with the earlier
Better Auth callback issue, an own-account Cloudflare deployment can expose the
request to the worker with an internal `http://` scheme even though the public
custom domain is HTTPS. That made an infrastructure detail leak into the
public OAuth protocol response.

## Fix

Build the challenge URL from the URL-validated `WRIGHTFUL_PUBLIC_URL` binding,
then normalize it to its origin. This is the same canonical external URL used
by the dashboard's auth configuration and still permits `http://localhost` in
local environments.

The worker regression test now deliberately sends an HTTP request while
configuring an HTTPS public URL and asserts that every MCP 401 advertises the
HTTPS metadata endpoint.

## Verification

- Focused MCP auth worker suite — 10/10 passing.
- `pnpm --filter @wrightful/dashboard test:workers` — 113 files and 1,329
  tests passing.
- `pnpm check` — exit 0 (139 existing warnings, no errors).
