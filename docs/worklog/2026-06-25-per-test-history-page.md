# 2026-06-25 — Per-test history page (`/tests/:testId`)

## What changed

Added a dedicated **test-level history page** at
`/t/:teamSlug/p/:projectSlug/tests/:testId`, keyed by the stable `testId`
(the 16-char hash from `packages/reporter/src/test-id.ts`). It answers "how has
THIS test behaved over time?" independent of any single run.

Previously, clicking a row in the **tests catalog** (and in the **slowest-tests**
insight) jumped to the _latest run's_ result-detail page
(`runs/:runId/tests/:testResultId`). That was an odd indirection: a test's history
is not a property of one run. Both row links now point at the new test page; the
run-scoped result-detail page stays the deep-dive (attempts, errors, artifacts)
you click _into_ from the history rows.

### The page

- **Header** — `Tests ›` crumb, latest-status badge, test title, the file /
  describe-chain / "tracked since" subtitle, tag badges, and the existing
  `QuarantineControl` (owner-gated, posts to the shared quarantine route with a
  `redirectTo` back to this page). Mirrors the result-detail header's structure.
- **KPI strip** — four `AnalyticsKpiCard`s: pass rate, flakiness rate, avg
  duration (with p95 footnote), total runs (with last-seen footnote). All-time.
- **Duration trend** — the shared `RunHistoryChart` over the last 30 results
  (the chart's cap). Right-slot pass%/×/⚠ summary is computed over the _visible
  window_, matching the result-detail strip — the KPIs above carry the all-time
  numbers.
- **Recent runs table** — `ui/table` with the catalog's stretched-link row
  pattern; each row (status glyph, run #id + commit subject, branch · short sha,
  duration, relative time) links into the run-scoped result detail.

It's almost entirely reuse — no new UI primitives. The chart query already
existed inside the result-detail loader (last-30 history by `testId`); this page
promotes it to a first-class destination.

## Details

| File                                         | Change                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/.../tests/[testId]/index.server.ts`   | **New** loader. Parallel reads: all-time aggregate (raw `runRow`, casts via `intAggExpr`/`numAggExpr`/`statusCounter`, `percentile_cont(0.95)` for p95, `min`/`max(createdAt)`→double precision); last-60 history (Drizzle builder, `ciRunsJoinOn()` excludes synthetic); tag union; quarantine state. Returns `kind: "ok" \| "not_found"`. |
| `pages/.../tests/[testId]/index.tsx`         | **New** page (RSC, no client island — `QuarantineControl` is a plain `<form>` POST).                                                                                                                                                                                                                                                        |
| `pages/.../tests.tsx`                        | Catalog row href → `tests/:testId` (was `runs/:latestRunId/tests/:latestTestResultId?attempt=0`).                                                                                                                                                                                                                                           |
| `pages/.../insights/slowest-tests.tsx`       | Same row href change, for consistency.                                                                                                                                                                                                                                                                                                      |
| `pages/.../tests.server.ts`                  | Removed now-dead `latestRunId` / `latestTestResultId` from `TestsPageRow` + `AggregateRow` + the SELECT + mapping (they existed only to build the old href).                                                                                                                                                                                |
| `pages/.../insights/slowest-tests.server.ts` | Same removal from `BottleneckRow` + SELECT.                                                                                                                                                                                                                                                                                                 |

`latestStatus` was left in the catalog loader (pre-existing, unrelated to the
link change).

### Shared history view (code-quality pass)

The new page first hand-rolled the `historyRows → RunHistoryPoint[]` mapping +
the pass/fail/flaky window summary — a verbatim copy of the run-scoped
result-detail page. Extracted both into one owner:

- **`src/lib/test-history-view.ts`** — `buildTestHistoryView(rows, opts)` →
  `{ points, stats }`. Owns the bar label / hover / href shape and the window
  stats; `currentTestResultId` (result-detail only) marks the viewed bar inert.
  Both pages call it; the result-detail page lost ~45 lines.
  - **Latent bug fixed in passing:** the hand-rolled stats counted
    `status !== "skipped"` as ran and `=== "failed"`/`=== "flaky"` for the
    buckets, so `interrupted` (neither) was silently scored a **pass**. The
    helper routes status through the canonical `statusGroupKey`
    (`interrupted → flaky`, `timedout → failed`). Pinned by
    `src/__tests__/test-history-view.workers.test.ts` (6 cases).
- **`src/lib/text.ts`** — `firstLine(commitMessage)` was about to be a third
  copy (the new table, plus two in `run-history-bar-hover`); promoted to a
  shared util and reused there.

### Heading-baseline drift + `DetailHeaderBar` (header consolidation)

The new test page's heading dropped a couple px when navigating from the tests
catalog. Root cause: the catalog uses `PageHeader` — a fixed **`h-[52px]
items-center`** title bar — while detail pages hand-rolled **padding-based**
(`py-4` / `pt-4 pb-4` / `pt-[18px]`) headers, whose title baseline is derived
from `py` + text metrics + borders and so drifts against the 52px bar (the
`runs/[runId]` header already had a comment noting exactly this).

This was systemic — every bespoke detail header hand-rolled the chrome and most
drifted. Extracted **`DetailHeaderBar`** (in `page-header.tsx`) as the single
owner of the `h-[52px] items-center px-6` geometry; pages compose their own
crumbs/status/title/actions as children and add border/justify/sticky via
`className`, with any metadata row as a separate sibling block. Routed **all
seven** title bars through it:

| Page                                                | Was                                                     |
| --------------------------------------------------- | ------------------------------------------------------- |
| `page-header.tsx` `PageHeader`                      | inline 52px chrome (now delegates to `DetailHeaderBar`) |
| `runs/[runId]` (run detail)                         | inline 52px chrome                                      |
| `runs/[runId]/tests/[testResultId]` (result detail) | `py-4` — **drifted**                                    |
| `runs/[runId]/diff.tsx` (run diff)                  | `pt-[18px]` — **drifted**                               |
| `tests/[testId]` (test history)                     | `py-4` — **drifted**                                    |
| `monitors/[monitorId]` new + detail                 | `pt-4 pb-4` — **drifted**                               |

`h-[52px]` now appears in exactly one place (`page-header.tsx`). The settings
area keeps its own `SettingsHeader` — a separate design with no cross-navigation
to the app title bar, so it's intentionally not folded in.

### Route coexistence

`tests.tsx` (the catalog, a flat file) sits beside a new `tests/` directory —
the same file+same-named-directory pattern already used by
`settings/.../projects.tsx` + `projects/new.tsx`. Verified it resolves.

### Tenancy / SQL notes

- Every read scopes by the branded `TenantScope` `projectId`
  (`childByTestIdWhere`, `testResultsScopeJoin`-style join, `loadQuarantineByTestId`).
- The all-time aggregate is a raw `runRow`, so it bakes the pg int8/numeric
  coercions into SQL (the int8-as-string trap pglite hides). `createdAt` is
  `bigint` → cast to `double precision` for `min`/`max`; counters/`count` cast to
  `integer`; `avg`/`percentile` to `double precision`. The history query uses the
  Drizzle builder, where field decoders handle `createdAt` (`mode:"number"`).
- No new GROUP BY / 2-arg `min`/`max` (the SQLite-isms that throw on pg) — the
  aggregate is a single-row aggregate; the tag union uses `selectDistinct`.
- **Ambiguous-column trap (caught against real pg, fixed):** the aggregate's
  `avg(...)` over duration was first written `avg("durationMs")` — bare. Once
  `runs` is joined in, that's ambiguous (`runs` ALSO has a `durationMs` column →
  `42702 column reference "durationMs" is ambiguous`), a runtime error pglite +
  the typechecker don't see. Now qualified `avg(tr."durationMs")` (the
  `percentile_cont` was already `tr.`-qualified).

### Follow-up fix — chart window vs. summary mismatch (2026-06-26)

The loader fetches up to `HISTORY_LIMIT` (60) results, but `RunHistoryChart`
only plots the most recent 30 (`maxPoints`). The page built its chart view —
`buildTestHistoryView` — from the full 60-row `history`, so when a test had >30
non-synthetic results the title (`last N runs of this test`) reported 60 while
only 30 bars rendered, and the right-slot pass%/×/⚠ summary covered the wider
60-run window rather than the 30 the chart drew. (The run-scoped result-detail
page never hit this because its own `HISTORY_LIMIT` is 30.)

Fix: build the chart view from the same window the chart plots —
`history.slice(0, RUN_HISTORY_CHART_MAX_POINTS)`. The slot count is now an
exported constant (`RUN_HISTORY_CHART_MAX_POINTS` in `run-history-chart.tsx`,
also the `maxPoints` default) so the page's slice and the chart's cap can't
drift apart. The recent-runs table still lists all loaded history (up to 60) —
only the chart + its summary are windowed to 30.

## Verification

- `pnpm check` (oxfmt + oxlint + type-aware typecheck) — **0 errors**. (120
  pre-existing `no-unsafe-type-assertion` warnings in reporter/e2e, none in the
  new/changed files.)
- `pnpm --filter @wrightful/dashboard test` — **1,331 passed** (218 + 1,113),
  5 skipped (includes the 6 new `buildTestHistoryView` cases). No tests
  referenced the removed loader fields.
- **Validated against the real local Postgres** (`docker-compose.pg.yml`, the
  same store `pnpm dev` uses — pglite is only the fast unit lane). Ran the exact
  aggregate + history-join + tag-union queries via node-postgres against a real
  seeded test: query is valid pg and every count/sum/avg/min/max comes back a JS
  `number`, not the int8/numeric string. This surfaced and fixed the ambiguous
  `durationMs` above.
- Remaining manual check: a dev-server click-through of the page UI itself
  (the data layer is now real-pg-verified).
