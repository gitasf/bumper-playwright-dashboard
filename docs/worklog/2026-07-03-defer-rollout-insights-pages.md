# 2026-07-03 — Deferred-loading rollout: survey + insights/index & run-duration

## What changed

Continued — and **completed** — the `defer()`/skeleton rollout beyond the three
exemplar pages (insights/suite-size, insights/slowest-tests, runs/[runId]). First
surveyed **all** remaining candidate project pages to decide which genuinely
benefit and how to split each (the survey disposition below), then converted
every page marked defer/partial across three tiers: Tier 1 (the remaining
insights tabs — suite-size twins), Tier 2 (flaky + the test-result detail),
Tier 3 (runs/[runId]/diff + the tests catalog), plus the settings audit log.
Only the three **skip** pages remain eager, by design (see Remaining). This
entry grew across several sessions; the section order below is roughly the order
the batches landed.

## Survey disposition (10 candidate pages)

| Page                                | Verdict             | Why                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insights/index` (Run Status)       | **defer** ✅ done   | one bucketed GROUP BY → 3 KPI cards + stacked bar chart; suite-size twin                                                                                                                                                                            |
| `insights/run-duration`             | **defer** ✅ done   | two percentile passes → 3 KPI cards + line chart; suite-size twin                                                                                                                                                                                   |
| `flaky`                             | **defer** ✅ done   | heaviest loader (4+ passes + per-test fan-outs); no action (owner mutation is a separate redirect route); needed a `KpiInline`-shaped skeleton for the toolbar strip                                                                                |
| `runs/[runId]/tests/[testResultId]` | **partial** ✅ done | deferred the artifact-signing fan-out + history chart (reuses `RunHistoryChartSkeleton`); kept the 404 gate/attempt tabs/tags eager; dropped the `maxObservedAttempt` coupling                                                                      |
| `runs/[runId]/diff`                 | **defer** ✅ done   | two full `testResults` scans + diff deferred as `{diff, counts}`; head/base gate + selector + no-baseline empty kept eager; `run-diff.ts` split additively (`resolveRunDiffTargets` + `computeRunDiff`) so `resolveRunDiff` (JSON API) is unchanged |
| `tests` (catalog)                   | **defer** ✅ done   | primary-content defer (whole two-pass table + pagination streams); fixed-column table skeleton + deferred footer; toolbar + tag chips eager                                                                                                         |
| `tests/[testId]`                    | **skip**            | the two heaviest reads _are_ the 404 existence gate (`aggregate`/`history[0]`); can't defer without faking existence, and the data is single-test-scoped (not heavy)                                                                                |
| project index (overview)            | **skip**            | the runs list is a `useProjectRoom` realtime seed (rooms have no replay); deferring breaks live run-created/progress. No secondary region to peel off                                                                                               |
| `monitors/[monitorId]`              | **skip**            | above-fold header uptime cells read the heaviest queries; all below-fold data is action-mutated; reads are bounded single-monitor aggregates (not the heavy class)                                                                                  |
| settings audit log                  | **defer** ✅ done   | owner-only paginated list; count + pagination shell + "Activity · N" card title kept eager, the row slice + `getUsersByIds` actor-name hydration deferred behind a table skeleton                                                                   |

## Details — the two conversions

Both follow the established pattern (eager shell + `defer()` grouped resolver +
`use()`-reading child components under `<DeferredSection>` + `Cache-Control:
private, no-store`), reusing the shared `KpiCardSkeleton` and `ChartSkeleton`.

- **`insights/index.server.ts` / `.tsx`** — the single `aggRows` GROUP BY + its
  server-assembled `kpis` now stream as one grouped `outcomes` resolver (grouped
  so the KPI numbers can't tear from the chart they summarize). The page splits
  into `RunStatusKpis` (3 KPI cards + per-bucket sparklines) and `OutcomesChart`
  (the stacked `BucketBarChart`, which builds its bucket JSX + tooltips in the
  child since the resolver must stay serializable). The KPI row uses one
  `DeferredSection` wrapping all three `KpiCardSkeleton`s; the chart its own with
  `ChartSkeleton height={320}`.
- **`insights/run-duration.server.ts` / `.tsx`** — the `perBucket` + `overall`
  percentile passes stream as one grouped `duration` resolver (grouped so each
  KPI card's value (`overall`) and its sparkline (`perBucket`) resolve together).
  The page splits into `DurationKpis` (p50/p90/p95 cards) and `DurationChart`
  (the `AnalyticsLineChart`). Same skeleton split.
- Both: the static chart **legend** stays eager (below the chart skeleton) so it
  reserves its space in both states — no CLS. `resetKey` = `${range}:${branch}:${segment}`
  on each section (clears a latched error boundary on filter nav), copied from
  suite-size. Cache header flipped from SWR (`max-age=300, stale-while-revalidate=900`)
  to `private, no-store`.

## Details — Tier 2 (`flaky` + test-result detail)

- **`flaky.server.ts` / `.tsx`** — the entire flaky payload (PASS 1 aggregate →
  PASS 2 sparkline/failure/tag/owner fan-out — the heaviest reads in the app)
  now streams as one grouped `flaky` resolver. This pulls the toolbar KPI strip
  into the deferred region (its three numbers derive from PASS 1), so the page
  splits into `FlakyKpiStrip` (behind a new `KpiInline`-shaped `FlakyKpiSkeleton`
  — the toolbar's fixed `min-h-13` means the placeholder height can't shift it)
  and `FlakyTableRegion` (Empty-or-table + footer, behind `FlakyTableSkeleton`).
  A shared `FlakyTableHead` keeps the 7 column widths identical between the live
  table and its skeleton; rows use raw `h-[13px]`/`h-[11px]` (leading-none cells)
  for a 51px row matching `FlakyTestRow`. `branches`/`ownerError` stay eager
  (toolbar filter + post-redirect banner). Skeleton row count is a fixed 8 (real
  count unknown until PASS 1; terminal region). Cache → `no-store`.
- **`runs/[runId]/tests/[testResultId]` `.server.ts` / `.tsx`** — the 404 gate
  (result + run), tags, annotations, per-attempt rows and quarantine stay eager
  (they drive the header, metadata, attempt tabs and error panels). Two regions
  defer independently: the **history strip** (bounded 30-row scan → `RunHistoryChartRegion`
  behind `RunHistoryChartSkeleton`, passing the eager `file` subtitle + a stable
  "Duration" title so the shared frame's title row is identical across the swap)
  and the **artifact rail** (the token-signing / SigV4 presign fan-out →
  `TestArtifactsRail` behind `ArtifactsRailSkeleton`). Safe because `AttemptTabsBar`
  and `AttemptPanel` sync purely via the `?attempt=` URL param (no shared React
  context), so a Suspense boundary between the eager left column and the deferred
  right rail is invisible and switching attempts (shallow param) doesn't
  re-suspend. **Dropped the `maxObservedAttempt` term** from the attempt-tab
  count so the eager left column never reads the deferred artifact data (it now
  trusts the reporter's `retryCount + 1`). Cache → `no-store`.

## Details — Tier 3 + audit (`runs/[runId]/diff`, `tests` catalog, audit log)

- **`run-diff.ts`** — split **additively** so the diff page can defer only the
  heavy half: `resolveRunDiffTargets` (head 404 gate + base resolution — cheap
  single-row lookups) and `computeRunDiff` (the two full per-test scans +
  `diffRuns`). `resolveRunDiff` now composes the two, so the **JSON API caller
  is byte-for-byte unchanged** and the base-selection branches still live in one
  place. All 31 `run-diff.workers.test.ts` tests pass.
- **`runs/[runId]/diff` `.server.ts` / `.tsx`** — the loader resolves the gate +
  base + base-candidate selector eagerly; the scans + `counts` defer as one
  `comparison` group. `base` stays eager, so the shell picks the diff body vs
  the no-baseline empty state without waiting; only the CountPill row + bucket
  tables defer (behind `DiffBodySkeleton`). Cache → `no-store`.
- **`tests` catalog `.server.ts` / `.tsx`** — the two-pass query (paginated
  slice + windowed total, then the per-test aggregate) + all pagination math
  defer as one `catalog` group; the toolbar (search / branch / group / range)
  and tag chips stay eager. The raw URL `requestedPage` is returned eagerly so
  the group-toggle hrefs preserve the current page; the clamped `currentPage`
  streams with the slice. A `TestsCatalogHead` is shared by the live table and
  its fixed-column skeleton. Cache flipped SWR → `no-store`.
- **settings audit log `.server.ts` / `.tsx`** — the owner-only gate + count +
  pagination shell + "Activity · N" card title stay eager; the row select +
  `getUsersByIds` actor-name hydration defer behind a table skeleton (shared
  `AuditTableHead`). Cache → `no-store`. A marginal win (a 50-row settings
  list), converted for completeness.

### Gotcha: `defer()` ⊗ `defineHandler.withValidator` (fixed 2026-07-04)

Both `tests` and `audit` originally used `defineHandler.withValidator({ query })`
for typed search params. That **crashes at runtime with `defer()`**: the
validator path awaits/serializes the handler return, collapsing the `Deferred`
prop into its plain resolved object, so the client's `use(catalog)` throws
`An unsupported type was passed to use(): [object Object]`. Types still say
`Deferred<T>`, so tsgo + build passed and it only surfaced on the live page.
**Fix:** both loaders converted to plain `defineHandler` + manual `searchParams`
parsing (matching the sibling insights/flaky loaders — `makeRangeParser`,
`normalizeBranchFilter`, `parseInt(...,10)` + `Number.isFinite && >0`, manual
`file|suite` enum check). The typed-query contract in `.void/routes.d.ts` is
only consumed by `void/client#fetch` callers; nothing fetches these page
loaders, so the loss is a no-op. The `.tsx` pages were unchanged (the resolved
prop shapes are identical — only the `Awaited<InferProps>` wrapper, the tell for
a withValidator loader, dropped to `InferProps`).

## Verification

- `void prepare && tsgo --noEmit` — **0 errors** across both batches (the grouped
  deferred props — `outcomes`, `duration`, `flaky`, and the test-detail
  `history`/`artifacts` on the `kind:"ok"` union variant — flow through
  `InferProps` and `use()` unwraps them).
- `pnpm --filter @wrightful/dashboard build` — both SSR + client bundles built clean.
- `pnpm check` — **0 errors**; the 121 warnings are all pre-existing in unrelated
  files; none in the changed files.
- `run-diff.workers.test.ts` — **31/31 pass** (guards the additive `run-diff.ts`
  split, since it's a shared lib the JSON API also calls).
- Runtime confirmation on the dev server is the user's next step. All three
  established runtime findings still hold (the two Void patches — pg-pool +
  X-VoidPages, and the useId patch — plus the no-store rule are already in place).

## Remaining

Every page the survey marked **defer**/**partial** is now converted — Tier 1
(insights/index, run-duration), Tier 2 (flaky, test-result detail), Tier 3
(runs/[runId]/diff, tests catalog), plus the settings audit log. Only the three
**skip** pages are intentionally left eager, because `defer()` is the wrong tool
for each: `tests/[testId]` (the heaviest reads _are_ the 404 existence gate),
the project index / runs list (it's a `useProjectRoom` realtime seed — deferring
would drop live events), and `monitors/[monitorId]` (above-fold header uptime
reads the heaviest query + all below-fold data is action-mutated). Converting
any of those would regress behavior, not improve it.
