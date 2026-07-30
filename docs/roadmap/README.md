# Wrightful — Feature Roadmap

Wrightful's core loop — streaming ingest → analytics → flaky detection → artifacts → realtime — is ~90% done and solid. The remaining work is at the edges: turning insights into **actions** (gating, quarantine, ownership), **sharing/collaboration**, **monetization**, **enterprise admin**, and finishing several half-built or stubbed surfaces.

Schema changes are forward-only: update `apps/dashboard/db/schema.ts`, generate
a new committed migration, and never rewrite one that may already have been
applied.

Each feature below has its own grounded plan file (schema, routes/pages, reuse seams, verification). Features are grouped by priority and are largely independent — pick them up in any order, though a suggested sequence is noted per tier. **Email-sending + alerting are tracked separately and excluded here.**

## Recurring reuse seams (referenced across plans)

- **Tenant scoping:** branded `TenantScope` / `AuthorizedProjectId` (`src/lib/scope.ts`), `tenantScopeForApiKey` (ingest), `requireTenantContext` / `resolveTenantApiScope` (session).
- **Signed-token pattern:** `src/lib/artifacts/tokens.ts` + `src/lib/token-crypto.ts` (HMAC via `crypto.subtle`, `timingSafeEqualBytes`, base64url).
- **Ingest pipeline + atomic transactions:** `src/lib/ingest.ts` (`openRun`/`appendRunResults`/`completeRun`, `aggregateDeltaStatement`) through `runBatch`.
- **Cron sweepers:** `crons/sweep-stuck-runs.ts` → `sweepStaleRuns` + `drainStaleRuns` (bounded `.limit`, `WRIGHTFUL_SWEEP_BATCH_SIZE`). Void crons use `defineScheduled` with a **unique cron expression per file** (dispatched via `switch(controller.cron)`) — never collide expressions.
- **Settings gating:** `src/lib/settings-scope.ts` (`requireOwnerScope`/`requireRoleScope`, `gateTeamScope`).
- **Analytics filters:** `src/lib/analytics/filters.ts` (`branchFragment`/`searchFragment`/`escapeLike`), `useSearchParam`/`useNavigatingSearchParam`.
- **UI:** `src/components/ui/*` (Base UI wrappers), `cn()`, filter controls in `src/components/filter-controls.tsx`.
- **Wire contract sync:** `packages/reporter/src/types.ts` ↔ `apps/dashboard/src/lib/schemas.ts`, canary `contract*.test.ts` suites.

## Index

### Tier 1 — Needed to launch as a product

_Suggested sequence: metering + retention de-risk cost exposure before opening signups._

1. [Billing / usage metering + quota enforcement](./1.1-billing-usage-metering.md)
2. [Retention enforcement (two-axis)](./1.2-retention-enforcement.md)
3. [GitHub Checks / Commit Status API](./1.3-github-checks.md)
4. ~~Public / shareable run links~~ — **dropped**: the product keeps everything behind auth, so there are no anonymous/public views.

### Tier 2 — Strong differentiators / competitive parity

5. [Tag filtering + hierarchical file/suite grouping](./2.1-tag-filtering-grouping.md) _(cheapest win)_
6. [Flaky test quarantine workflow](./2.2-flaky-quarantine.md)
7. [Test ownership / CODEOWNERS](./2.3-test-ownership-codeowners.md)
8. [Run-to-run comparison / diff](./2.4-run-diff.md)
9. [Data export + public query API](./2.5-data-export-api.md)
10. [TCP/ping monitors + deferred uptime phases](./2.6-tcp-ping-monitors.md)

### Tier 3 — Enterprise (defer until a paying customer pulls)

11. [Granular RBAC + member-role editing](./3.1-granular-rbac.md)
12. [Audit logs](./3.2-audit-logs.md)
13. [SSO / SAML](./3.3-sso-saml.md) — **deferred**: scaffolding built then reverted (the `@better-auth/sso` dependency isn't Cloudflare-Workers-compatible); the plan documents the blocker + how to finish.

### Tier 4 — Polish bundle (finishing existing stubs)

14. [Polish bundle: date-range presets, density toggle, command-menu search](./4.1-polish-bundle.md)

## Global verification (applies to every feature)

- `pnpm check` (format + lint + type-check via `vp check`) and `pnpm test` (dashboard + reporter unit) — dashboard tests run via `vp test run`, not `exec vitest run`.
- Schema changes: `pnpm --filter @wrightful/dashboard db:generate`; the reporter's `contract*.test.ts` canaries must stay green for any wire-type change.
- A worklog entry in `docs/worklog/` per feature (required by `CLAUDE.md`).
- Manual e2e via `packages/e2e` with `WRIGHTFUL_URL`/`WRIGHTFUL_TOKEN` set for ingest/reporter-touching features.
