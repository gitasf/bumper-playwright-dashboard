# Wrightful — Architecture, Structure & Code Quality Review (2026-07-03)

**Scope:** whole-repo — architecture & module boundaries, tenant isolation/security,
database performance, core-logic correctness, reporter + wire contract, frontend
quality, test suite, OSS readiness, systemic scalability.

**Method:** a multi-agent review fanned out across 9 dimensions (per-dimension
deep review → structured findings), ~55 findings total. Every **high** finding
below was then re-verified by hand against the actual code (reading the cited
files/lines) before inclusion; medium findings carry the dimension reviewer's
code-cited evidence but were not all independently re-verified. Three dimensions
(frontend, tests, scalability) were reviewed directly rather than via agents.

**Toolchain signal at review time:** `vp check` — 0 errors, 120 warnings
(mostly `no-unsafe-type-assertion`); all unit lanes green (dashboard 1126,
reporter 225 + 4 skipped, e2e-vitest 274).

---

## Verdict

This is an unusually disciplined codebase for its size (~54k lines of TS). The
project's own documented rules are actually followed in the code, not just in
CLAUDE.md: routes really are auth + translation over deep modules, the branded
tenant-scope types are genuinely load-bearing (zero brand casts outside
`scope.ts` and tests), page loaders are uniform, and the schema file is
exemplary. **No critical findings and no cross-tenant read/write path was
found.** The five high-severity items are concentrated where growth will hurt
first: the ingest hot path's per-row statement fan-out, and four
correctness/scale cracks at the edges of otherwise-sound designs.

---

## What is genuinely strong

- **Tenant isolation is airtight in practice.** All ~45 query sites against
  tenant tables use the blessed predicate family (`runScopeWhere`,
  `childBy*Where`) or the raw-SQL scope fragments with bound params; the only
  string→brand launder lives in `makeTenantScope` with lint suppressions scoped
  to exactly those lines. Cross-tenant denial is tested at the seams (analytics
  filters, artifact tokens, topic subscription, ingest guards, settings scope,
  export).
- **Layering discipline is real.** `routes/api/runs/*` and
  `routes/api/artifacts/*` are pure auth + Zod translation over
  discriminated-union results from `src/lib/ingest.ts` / `artifacts.ts`.
  Invariants are concentrated (`ingest-routes.ts` shared by the auth and
  rate-limit gates; `error-outcome.ts` as a pure decision table).
- **Security has been threat-modeled, not bolted on.** Constant-time API-key
  compare + pre-auth IP rate limiting; artifact content-type allowlist at
  register _and_ normalization at serve, forced attachment disposition,
  tenant-prefixed sanitized R2 keys, a test binding the allowlist to the CSP;
  confused-deputy classes actively closed (check-run installation scoped to the
  run's team, installation-id hijack guard); IPv6-aware SSRF policy on monitors;
  invite tokens hashed with verified-email matching.
- **The wire contract is guarded.** `contract.test.ts` imports the dashboard's
  Zod schemas cross-package; `pg-integration.test.ts` covers the exact traps the
  fast pglite lane hides (65535-param chunking, JS/SQL status-merge matrix
  parity, UTC bucketing, int8-as-string coercions).
- **Frontend conventions are fully honored.** Zero direct
  `@base-ui-components/react` imports outside `ui/`, no internal `<a>` tags,
  minimal `"use client"`, loaders parallelize via `Promise.all`, run-detail SSR
  seeds a cursor-paginated first page (200) shared with the API back-paginator,
  and realtime folds per-flush events through a pure reducer — no per-test event
  storms.
- **Operational design shows maturity.** Retention drain is budget-bounded
  (wall-clock + chunk caps) with a pure, tested orchestrator; broadcasts project
  the summary transactionally via `.returning()`; artifact bytes stream through
  the Worker both directions (no buffering) with exact Content-Length
  enforcement; crons document their non-colliding expressions.
- **Worklog discipline** (129 entries) plus ADRs give contributors real decision
  context.

---

## P1 — High (all hand-verified)

### 1. Ingest `/results` flush issues ~4 sequential statements per result inside one transaction

`src/lib/ingest.ts:283-336`, `src/lib/db-batch.ts:38`
Because the reporter always sends `plannedTests` and `openRun` prefills them as
`queued` rows, **every** result takes the existing-row path:
UPDATE + `testTags` DELETE + `testAnnotations` DELETE per row, plus an
unconditional `testResultAttempts` DELETE for every result (even fresh inserts).
`runBatch` awaits statements strictly sequentially on one connection
("Sequential on purpose"), so a default batch of 20 is ~80 round-trips over
Hyperdrive inside an open transaction; a 10k-test run pays ~40k. This defeats
the file's own chunking design and is the #1 hot-path scaling wall.
**Fix:** batch the child-table DELETEs as three `IN`-list statements per flush
and fold the per-row UPDATEs into a single multi-row upsert
(`INSERT … ON CONFLICT (runId, testId) DO UPDATE`).

### 2. Artifact re-registration never refreshes `sizeBytes` → CI re-run uploads rejected

`src/lib/artifacts.ts:231` (reuse), `:543` (guard)
CI re-runs share the run's idempotency key by design, so artifacts re-register
with the same identity tuple. `planArtifactRegistration` reuses the existing row
verbatim — but the upload guard enforces `contentLength !== row.sizeBytes` from
the **stale row**, while the new trace/screenshot bytes almost never match the
old size. Result: every re-run artifact upload 400s with `lengthMismatch`.
**Fix:** on identity reuse, UPDATE the row's `sizeBytes`/`contentType` to the
re-registered values (and re-check the team cap).

### 3. Monitor alerts fire "down" + spurious "recovery" emails on single retryable infra errors

`src/lib/monitors/executor.ts:238,249`, `src/lib/monitors/alerts.tsx:41,169`
Executor throws / sandbox-unavailable produce `infraErrorResult` (`state:
'error'`, `infraError: true`) and request a **queue retry** — but `safeAlert`
runs with that result, `DOWN_STATES` includes `'error'`, and `classifyAlert` is
purely edge-triggered with no `infraError` exclusion and no streak threshold
(the streak logic only feeds the recovery email's stats). One transient hiccup
emails every recipient "🔴 down", then the successful retry emails "recovered".
**Fix:** skip (or defer) alerting when `result.infraError` and a retry is being
requested; only alert on the retry's terminal outcome.

### 4. Retention drain never rotates across invocations — projects beyond the chunk budget are never swept

`src/lib/retention.ts:126,261`
`sweepRetention` loads all projects with no ORDER BY/cursor;
`drainRetention` charges one chunk per project per round (idle projects still
cost 2 probe SELECTs + `recordChunk()`), budget defaults 120 chunks / 20s per
6-hour invocation, and nothing persists progress. Beyond ~120 projects (or when
early projects' backlogs consume the budget), the tail of the list is starved
**every** pass — unbounded retention violation for those tenants.
**Fix:** persist a rotation cursor (or `ORDER BY random()` per pass), and don't
charge full chunks for projects with nothing eligible.

### 5. Command-palette test search is an un-indexable `ILIKE '%q%'` scan per keystroke

`src/lib/command-search.ts:45`, `routes/api/t/…/search.ts:76-87`
Leading-wildcard ILIKE on `title`/`file` with only the project-scope predicate,
grouped by `(testId, title, file)` and sorted by `max(createdAt)` **before**
`LIMIT 8`. No trigram/tsvector index exists. At design scale (≈27M retained
`testResults` rows for a busy project) this is a multi-second full-partition
scan fired on each ⌘K keystroke.
**Fix:** add a `pg_trgm` GIN index on `(title, file)` (or search a distinct
tests summary table instead of raw results), and debounce server-side.

---

## P2 — Medium (grouped; reviewer-verified with code citations)

**Correctness / ingest**

- Aggregate deltas computed from a **pre-transaction** read
  (`ingest.ts:1171`): the reporter's 30s client timeout + retry can process the
  same batch concurrently; since prefilled rows take the UPDATE path there is no
  unique-violation safety net, so counters can double-apply (negative/inflated
  live counts). Consider `FOR UPDATE` on the prev-status read or recompute-only.
- UPDATE path rewrites `testResults.createdAt` to write time
  (`ingest.ts:297`), silently making it "last-modified": usage metering can
  double-count re-streamed rows across a month boundary; analytics buckets skew.
  Split into `createdAt` (insert-only) + `updatedAt`.

**Database / scale**

- Run-detail pagination sorts by `(createdAt, id)` with no supporting index
  (`run-results-page.ts:133`) — every page top-N-sorts the whole run. Add
  `(runId, createdAt, id)` (or key the cursor by the existing `(runId, testId)`).
- Runs-list loader issues three unbounded `SELECT DISTINCT`s + `count(*)` over
  the never-retained `runs` table per page view (`index.server.ts:41`);
  comments still assume SQLite skip-scan. Cache/materialize filter vocabularies.
- Terminal aggregate recompute scans the run's rows six times per `/complete`
  (`ingest.ts:543`), inside the sharded path's `FOR UPDATE` section. One pass
  with `FILTER (WHERE …)` aggregates would do.
- The `void@0.9.2` patch opens a fresh `pg.Pool({max:1})` per query chain and
  never `.end()`s it (`patches/void@0.9.2.patch:35`) — ~4-5 new Hyperdrive
  connections per `/results` flush. Worth pushing a proper fix upstream.
- Usage page `count(*)`s the team's whole month of `testResults` on every view
  (`usage.ts:269`); project/team deletion is one synchronous cascading DELETE
  (`project-teardown.ts:61`) — both need bounding as data grows.

**Reporter robustness**

- `SIGTERM` handler suppresses default termination and Playwright ≤1.61 only
  watches SIGINT (`index.ts:473`) — suites can ignore graceful termination.
- Exhausted `/results` batches are dropped forever; the docstring's "fallback
  file" does not exist (`index.ts:396`). A 2-minute dashboard blip mid-run
  leaves permanent `queued` holes.
- Error messages/stacks sent untruncated (`index.ts:929`) — a huge assertion
  diff can 413 a whole batch non-retryably. Truncate client-side to the
  documented 64/128KB caps.
- Titles not preflighted against the hard `MAX.TITLE=2048` reject
  (`index.ts:872`) — one long data-driven title 400s `POST /api/runs` and
  disables streaming for the entire run. Truncate client-side.

**Security hardening (no exploit alone; tightens stated guarantees)**

- The idle-run write-closure rationale claims the idempotency key "never leaves
  the server", but run-detail/test-detail loaders serialize the **full** runs
  row — `idempotencyKey` included — into page props, and the reporter derives
  the key from public CI build ids (`runs/[runId]/index.server.ts:27`). Project
  columns explicitly (the `keys.server.ts` pattern) and/or salt the key.

**Docs / OSS readiness**

- `docs/ARCHITECTURE.md` denies the direct-R2 presign path that shipped and
  undercounts the crons; `SELF-HOSTING.md` documents retention defaults that
  changed (200 → 1000, new semantics) and omits the drain-budget + billing
  knobs; root `CLAUDE.md` lists `pnpm db:generate` / `deploy:cf` /
  `db:migrate:remote` which only exist in `apps/dashboard`.
- No `CONTRIBUTING.md`, `SECURITY.md` (most consequential — there is no
  vulnerability-reporting channel), `CODE_OF_CONDUCT.md`, or issue/PR templates.

**Architecture / organization**

- `ingest.ts` (1744 lines) hosts three separable domains — generic chunking
  utilities (`PG_MAX_BOUND_PARAMS`, `chunkByParams`, …), the run-status
  severity model, and the stale-run watchdog — forcing `retention.ts` and
  `artifacts.ts` to import the god module for a slicing helper. Extract
  `db-chunk.ts` (and consider `run-status.ts`, `stale-runs.ts`).
- `artifacts.ts` still chunks at `MAX_IN_ARRAY_IDS = 99` with a D1 comment —
  the identical leftover `retention.ts` already fixed (`artifacts.ts:47`).
- ~30 stale D1/rwsdk-era comments misdirect readers, including a schema pointer
  to a nonexistent `src/live.ts` (`db/schema.ts:370`). In a codebase whose
  comments are the primary architecture documentation, this drift is costly.

---

## P3 — Low (worthwhile polish)

- Analytics loaders embed raw-SQL CTE shells at a lower altitude than all other
  data access, with a copy-pasted IN-list idiom (`flaky.server.ts:271`).
- `quarantine-repo.ts:110` readers accept raw `string projectId` (brand erosion).
- `links.ts` rwsdk shim still alive with two callers.
- CSRF rests on cookie SameSite defaults configured outside the repo; CSP allows
  `'unsafe-inline'` scripts; token-authed artifact bytes marked publicly
  cacheable for a year (`artifacts.ts:714`).
- Reporter: 409 upgrade message discarded (`client.ts:194`); options never
  validated (batchSize over server cap silently drops results); trailing-slash
  base URL breaks ingest with a misleading 404; clientKey cap (256) tighter than
  testId cap (1024) though one defaults to the other.
- Contract canary doesn't exercise tags/annotations through `buildPayload`.
- E2E: a few hard waits (`realtime.spec.ts:114` 800ms, `a11y.spec.ts:42` 300ms,
  fixture boot sleeps) — mild flake risk.
- `reconcileUsage` iterates every team serially per cron pass (acknowledged in
  code); monitor cadence re-arms from sweep time, accumulating dispatch lag;
  runs CSV export pages at 200 not the documented 500 (`export.ts:297`).
- Release workflow uses mutable action tags while holding npm publish +
  id-token permissions; `apps/dashboard/todo.md` is a stale superseded design
  doc contradicting the Postgres-only architecture.

---

## Suggested sequence

1. **Ingest flush batching** (P1-1) + the two ingest correctness mediums
   (pre-transaction delta read, `createdAt` rewrite) — same file, one focused PR
   with pg-integration tests for the upsert path.
2. **Artifact re-run fix** (P1-2) — small, high user impact for CI re-runs.
3. **Monitor alert infra-error gating** (P1-3) — small, stops false pages.
4. **Retention rotation cursor** (P1-4) + command-search index (P1-5).
5. **Docs truth pass** — ARCHITECTURE.md, SELF-HOSTING.md env table, root
   CLAUDE.md commands, D1-era comment sweep, delete `todo.md`; add SECURITY.md +
   CONTRIBUTING.md.
6. **Reporter resilience** — client-side truncation (titles/errors), real
   fallback for dropped batches or remove the docstring promise, SIGTERM
   pass-through.
