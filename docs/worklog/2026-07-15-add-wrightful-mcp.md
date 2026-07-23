# 2026-07-15 — Add the Wrightful MCP server to Codex

## What changed

Added a project-scoped Codex MCP configuration for Wrightful. Trusted checkouts
now discover the hosted MCP endpoint at `https://dash.wrightful.dev/api/mcp`
without requiring every contributor to configure it manually.

## Details

- Added `.codex/config.toml` with the shared `mcp_servers.wrightful` entry.
- Kept machine-specific approval, sandbox, and unrelated MCP settings out of
  the repository configuration.
- HTTP transport is inferred by Codex from the `url` field.

## Verification

- Parsed `.codex/config.toml` with Python's `tomllib`.
- Confirmed the configured server name and URL.
- Ran the repository formatter against this worklog.
