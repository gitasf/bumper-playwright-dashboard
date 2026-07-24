# Wrightful MCP Server

Wrightful ships a built-in [Model Context Protocol](https://modelcontextprotocol.io)
server at **`/api/mcp`**, so coding agents (Claude Code, Cursor, VS Code
Copilot, …) can look up failing Playwright tests — by PR, commit, or branch —
read their error messages and retry history, and view their artifacts
(screenshots inline, traces/videos via signed download URLs).

It is part of the same Bearer-authenticated read surface as the
[public query API](./query-export.md): the endpoint ships with the dashboard
itself, so it works identically on the cloud app and on any self-hosted deploy —
there is nothing extra to install or run.

## Connecting

Two ways in, matching how you work:

### OAuth (recommended for interactive agents)

Add the server with no credentials and let the standard MCP OAuth flow run —
your browser opens, you sign in to the dashboard (if needed) and approve on a
consent screen:

```bash
claude mcp add --transport http wrightful https://<your-dashboard>/api/mcp
# then inside Claude Code: /mcp → wrightful → Authenticate
```

```json
{
  "mcpServers": {
    "wrightful": { "url": "https://<your-dashboard>/api/mcp" }
  }
}
```

Under the hood this is the spec flow end-to-end: the first 401 carries
`WWW-Authenticate: Bearer resource_metadata=…`; the client reads the
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`
documents at the dashboard origin, dynamically registers itself, and runs
authorization-code + PKCE against the dashboard's built-in Better Auth OAuth
provider. **Every grant goes through the consent screen** — the server forces
`prompt=consent`, so a signed-in browser can never be silently drained by a
freshly-registered client.

An OAuth token is **user-scoped**: the server exposes everything your account
can read. Tools take `team` + `project` slugs (membership-checked on every
call), and an extra `list_projects` tool enumerates your options.

### API key (headless / CI)

Mint a project **API key** (Settings → Project → API keys) — the same kind of
key the reporter uses — and pass it as a header. The key binds the server to
exactly one project, and the tools drop the `team`/`project` arguments:

```bash
claude mcp add --transport http wrightful https://<your-dashboard>/api/mcp \
  --header "Authorization: Bearer <key>"
```

For a self-hosted deploy, use your own dashboard origin
(`WRIGHTFUL_PUBLIC_URL`) as the base URL — the OAuth provider and discovery
documents ship with the app, so both connection styles work identically.
Requests are rate-limited per key/user under the same budget as the query API
(**429** + `Retry-After` when throttled).

Transport details: Streamable HTTP, **stateless** (no `Mcp-Session-Id`), plain
JSON responses. Only protocol messages needed for tools are served; GET/DELETE
(SSE channel / session teardown) answer 405, as the spec prescribes for
sessionless servers.

## Tools

All tools are read-only and tenant-scoped: with an API key the project is
fixed and no tool argument can reach outside it; with an OAuth token every
scoped tool requires `team` + `project` slugs and re-checks your membership on
each call.

| Extra tool (OAuth only) | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| `list_projects`         | Every team + project your account can read — call it first. |

| Tool               | What it does                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_runs`        | List runs, newest first. Filters: `pr` (PR number), `commit` (SHA prefix), `branch`, `status[]`, `environment`, `actor`, `from`/`to` dates, `origin` (`ci`/`synthetic`/`all`). Cursor-paginated.                                                                       |
| `get_run`          | One run's full summary: status, pass/fail/flaky/skipped counts, duration, commit/PR/branch/actor, CI provider, dashboard URL.                                                                                                                                          |
| `list_tests`       | A run's test results with truncated error messages. `status:"failed"` narrows to failures. Cursor-paginated.                                                                                                                                                           |
| `list_flaky_tests` | The project's flakiest tests over a trailing window (default 14 days), ranked by flake rate (flaky / flaky + passed — same definition as the dashboard's flaky page). Each row links its latest flaky `testResultId`.                                                  |
| `get_test_result`  | Full detail for one test: complete error message + stack, every retry attempt with its own error **plus captured `stdout`/`stderr`** (the test process's own `console.log` output), tags, annotations, and the artifact index (id/type/name/size/role).                |
| `get_artifact`     | Fetch one artifact. Screenshots ≤ 2 MiB return inline as an image; text artifacts ≤ 128 KiB inline as text; everything else returns a signed download URL (1 h normally, 8 h for replayable traces). Replayable traces also get a same-origin, self-hosted viewer URL. |

Typical agent flow: `list_runs {pr: 123, status: ["failed"]}` →
`list_tests {run_id, status: "failed"}` → `get_test_result {test_result_id}` →
`get_artifact {artifact_id}` for the failure screenshot or trace.

Flake-hunting flow ("find and fix my flaky tests"): `list_flaky_tests` →
`get_test_result {lastFlakyTestResultId}` — every retry attempt keeps its own
error **and its own artifacts**, so the failing attempt's screenshot/trace is
still there even though the retry passed. Compare the failing attempt against
the passing one, fix the test in the repo, and watch the next runs.

## Artifact bytes

`get_artifact` never streams large payloads through the MCP channel. Anything
not inlined returns the same short-lived HMAC-signed download URL the dashboard
uses (`/api/artifacts/:id/download?t=…`) — fetchable without an Authorization
header, so an agent can hand it to `curl`, a browser, or
`npx playwright show-trace <url>`. The response reports the chosen lifetime in
`downloadUrlExpiresInSeconds`: one hour for ordinary artifacts and eight hours
for replayable traces whose viewer may lazily request more ZIP ranges.

## Relationship to the other API surfaces

| Surface           | Path          | Auth                           | Notes                                        |
| ----------------- | ------------- | ------------------------------ | -------------------------------------------- |
| Reporter ingest   | `/api/runs/*` | Bearer + `X-Wrightful-Version` | Versioned write protocol.                    |
| Query/export (v1) | `/api/v1/*`   | Bearer API key                 | Stable read contract for CLIs/scripts.       |
| **MCP**           | `/api/mcp`    | Bearer API key **or** OAuth    | Same read surface, spoken over MCP JSON-RPC. |

MCP has no `X-Wrightful-Version` handshake — protocol versioning happens inside
MCP's own `initialize` negotiation.
