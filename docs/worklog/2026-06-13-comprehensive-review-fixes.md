# 2026-06-13 — Comprehensive codebase review + fixes

## What changed

A six-perspective review sweep of the whole monorepo (ingest/API surface,
auth/tenancy isolation, dashboard frontend, reporter + e2e packages, monitoring
backend/crons/queues/schema, and a cross-cutting DRY/consistency pass), followed
by implementation of every actionable finding. Headline: **no critical or
high-severity issues found** — no cross-tenant leaks (every tenant-table query
was verified to carry `projectId`), no SQL injection, no key exposure, no
floating promises after response, correct D1 param chunking, and a contract
(reporter ↔ Zod) that is in sync. The findings below are the low/medium tail.

## Fixes implemented

### Correctness

| Finding                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `appendRunResults` bumped team activity _before_ the "run vanished mid-batch" check — a wasted D1 write on the rare TOCTOU 404 path                                                                                                           | `src/lib/ingest.ts`: moved `if (!summary) return notFound` above `bumpTeamActivity`                                                                                                                                |
| Reporter artifact PUT sent a `Content-Length` from the `stat` captured at `onTestEnd`, but re-opens the file per retry attempt — a file rewritten between stat and attempt (video finalization, late retry) would mismatch the streamed bytes | `packages/reporter/src/client.ts`: `uploadArtifact` now derives `Content-Length` from the freshly opened Blob inside the per-attempt factory; dropped the now-unused `sizeBytes` param (call site + tests updated) |
| Artifact upload route parsed `Content-Length` with loose `Number()` (`"0x10"` → 16, `"12.5"` → 12.5) — defended downstream by the exact size match, but needlessly permissive                                                                 | `routes/api/artifacts/[id]/upload.ts`: strict `/^\d+$/` parse; non-integer forms become `NaN` and fail the match                                                                                                   |
| `validateApiKey` swallowed `lastUsedAt` bump failures with `.catch(() => {})` — persistent D1 write contention would be invisible in Cloudflare Tail                                                                                          | `src/lib/api-key.ts`: failure now logged via `logger.warn` (still never fails auth)                                                                                                                                |
| `prNumber` was the only numeric wire field without a lower bound                                                                                                                                                                              | `src/lib/schemas.ts`: added `.min(0)`                                                                                                                                                                              |
| HTTP monitor `shouldFail` semantics on the network-failure branch were undocumented (unreachable host records `fail` even for a should-fail monitor — the inversion only applies to response statuses)                                        | `src/lib/monitors/http/http-run.ts`: documented as the deliberate call (matches Checkly's treatment of timeouts)                                                                                                   |

### DRY / consistency

| Finding                                                                                                                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monitor-form.tsx` and `http-monitor-form.tsx` duplicated ~80 lines of scaffolding (`FieldLabel`, limit/error banners, enabled-switch footer, styled native select) — and had already drifted: the browser form hand-rolled the select `NativeSelect` had extracted, and the http `NativeSelect` lost the browser form's `w-full` | New `monitors/monitor-form-parts.tsx` exporting `FieldLabel`, `NativeSelect` (full-width by default, `twMerge` lets callers narrow), `MonitorFormBanners`, `EnabledSwitchRow`; both forms now import it |
| `queues/monitors.ts` and `queues/uptime.ts` consumer bodies were byte-identical apart from `retryDelay`                                                                                                                                                                                                                           | New `src/lib/monitors/queue-consumer.ts` with `makeMonitorQueueHandler(label, retryDelay)`; each queue file keeps only its tuning exports (Void reads those per-module) + rationale comments            |
| Slug cap `40` lived in two unlinked places — `SLUG_RE`'s hardcoded `{0,38}` in `slug.ts` and `SLUG_MAX_LEN` in `provisioning.ts`                                                                                                                                                                                                  | `SLUG_MAX_LEN` moved to `slug.ts` as the single source; `SLUG_RE`/`SLUG_ERROR` now derive from it; `provisioning.ts` re-exports for existing consumers                                                  |
| Status collapse rule encoded twice (`STATUS`/`statusGroupKey` in `status.ts`, `STATUS_BUCKET_MEMBERS` in `ingest.ts`) with a real-looking `interrupted` divergence                                                                                                                                                                | Verified the divergence is intentional (per-test wire statuses never include `interrupted`; it's run-level only) and cross-referenced both tables in comments so the next reader doesn't re-investigate |
| `normalizeTestStatus` hand-rolled a 6-way `s === "…"` disjunction                                                                                                                                                                                                                                                                 | Rewritten against one typed `TEST_STATUSES` list (no casts)                                                                                                                                             |
| Reporter's `formatDuration` is a deliberate copy of the dashboard's with divergent rounding (`12.3s` vs `12s`)                                                                                                                                                                                                                    | Documented the copy + the intentional rounding difference at the reporter definition                                                                                                                    |
| `runs_project_monitor_created_at_idx` has no consuming query (only the ingest write touches `runs.monitorId`) — pure write amplification today                                                                                                                                                                                    | Commented as reserved for the upcoming "runs for this monitor" list, with an instruction to drop it if the feature is cut (left in place; pre-launch migrations stay untouched until the call is made)  |

### Tests / e2e

| Finding                                                                                                                                                                                                               | Fix                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/e2e/tests/slow.spec.ts` — a self-described "temporary, delete when done" spec with five 8s sleeps and an intentional failure, running on every `pnpm test:e2e` globalSetup (~40s + seeded failure per boot) | Deleted                                                                                                                                                                                                                                                                                       |
| `seedSecondUser` created team/project via form-POST + 302 `Location` regex-scraping while `bootDashboard` uses the typed JSON API routes — two divergent contracts for one operation                                  | `tests-dashboard/helpers/second-user.ts` now hits the same JSON routes (`POST /api/teams`, `…/projects`) and asserts the returned slugs; the two helpers still can't physically share code (bare-fetch globalSetup vs Playwright `APIRequestContext`) but the endpoint contract is now single |
| `visual-regression.spec.ts` used `waitForLoadState("networkidle")` — the wait the runs-list page object explicitly avoids                                                                                             | Replaced with an explicit hero-heading locator wait (`toHaveScreenshot`'s stable-capture retry covers settling)                                                                                                                                                                               |

## Findings noted but deliberately NOT changed

- **`/api/*` has no middleware-level session-auth backstop** — every session API
  route calls `requireAuth`/`resolveTenantApiScope` as its first line (verified
  across all of them). Correct today; flagged as the most likely future
  regression point if the API surface grows.
- **`claimExecution` can re-run a settled real-error monitor execution on
  duplicate queue redelivery** — already documented at length in
  `monitors-repo.ts` as a bounded, converging tradeoff; closing it needs an
  `infraError` column. Deferred.
- **`uptime-monitors.spec.ts` fetches `https://example.com`** — a real external
  egress dependency in e2e. The spec is already status-agnostic; stubbing the
  fetch path properly is a larger change than this pass warranted.
- **`realtime.spec.ts`'s 800ms post-socket-open sleep** — the most likely
  residual UI-suite flake source. A clean fix needs a client-emitted
  room-ready signal (test-observable attribute on stable connect); deferred
  rather than half-fixed.
- **`links.ts` URL-builder shim** (rwsdk-era, self-flagged for removal, 2
  remaining consumers) — migration to `<Link href>` literals is mechanical but
  touches the command menu's programmatic navigation; left for a focused pass.
- **Artifact byte endpoints answer plain text while JSON APIs answer
  `{ error }`** — defensible split (binary endpoints aren't parsed for an
  `error` field); left as-is.

## Verification

- `pnpm check` (vp check: format + lint + type-aware typecheck) — exit 0,
  0 errors; 72 pre-existing warnings unchanged.
- `pnpm test` — dashboard 81 files / 867 tests passed; reporter 14 files /
  233 tests passed (includes the contract canary and the updated
  `uploadArtifact` / artifact-uploader tests).
- E2E suites not run in this pass (dev-server-booting suites; the e2e changes
  are a deletion, an endpoint swap asserting the same slugs, and a wait-style
  change).
