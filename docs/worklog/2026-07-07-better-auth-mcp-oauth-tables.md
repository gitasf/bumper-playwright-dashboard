# 2026-07-07 — Cover the MCP OAuth plugin tables in the own-account Better Auth DDL

## What changed

The own-account `wrangler deploy` path failed at `pnpm db:migrate:remote` with:

```
Error: migrate-remote: Better Auth schema added table(s) [oauthApplication, oauthAccessToken, oauthConsent] not in db/better-auth.sql — regenerate it from .void/better-auth-schema.ts.
```

The Vite build itself succeeded — the failure was the migrate-before-deploy step. Adding the Better Auth `mcp` OAuth plugin (see `auth.ts`, for `/api/mcp` OAuth) grew Void's generated `.void/better-auth-schema.ts` by three tables — `oauthApplication`, `oauthAccessToken`, `oauthConsent` — but the committed, hand-maintained `db/better-auth.sql` (applied on the own-account path, which Void's bare `void db migrate` does not create) still only covered `user` / `session` / `account` / `verification`. The drift guard in `scripts/migrate-remote.mjs` (`assertAuthSqlCoversSchema`) correctly caught the gap and failed the deploy — that's exactly its job.

## Details

- **`apps/dashboard/db/better-auth.sql`** — added idempotent `CREATE TABLE IF NOT EXISTS` DDL for the three OAuth-plugin tables plus their indexes, mirroring the generated schema. `oauthApplication.clientId` gets an inline `UNIQUE` constraint (not just a unique index) because both child tables FK to it, and a Postgres FK target needs a unique/PK constraint. `oauthApplication` is declared before the two tables that reference it.
- **`apps/dashboard/scripts/migrate-remote.mjs`** — extended the `AUTH_TABLES` allowlist (used by the drift guard and the "tables ensured" log) with the three new table names, and updated the header comment.

## Verification

- Applied `db/better-auth.sql` against a throwaway local Postgres 16: first apply creates all 7 tables + 10 indexes; a second apply is fully idempotent (every statement `NOTICE … already exists, skipping`, exit 0).
- Re-ran the drift-guard logic against `.void/better-auth-schema.ts`: all 7 generated tables are now in the allowlist → `missing: (none)`, guard passes.
- `pnpm check` → exit 0 (format + lint + type-check; only pre-existing warnings, none in the changed files).
