# 2026-07-03 — Deferred-loading skeletons: eliminate layout shift, match content

## What changed

The `defer()` skeletons landed in the [deferred-loading
foundation](./2026-07-02-deferred-loading-foundation-suite-size.md) reserved the
wrong box: every deferred region visibly **jumped** when the real data streamed
in and replaced the skeleton. This pass reworks the skeletons so each one
reserves the resolved content's box **to the pixel** and echoes its structure,
so the skeleton→content swap causes no cumulative layout shift (CLS).

### Root cause — skeleton bars ignored the real text line box

The skeletons sized text placeholders with fixed pixel heights (`h-3` = 12px,
`h-6` = 24px) that had nothing to do with the height the real text actually
occupies. In this Tailwind v4 app:

- Preflight sets the root `line-height: 1.5`.
- **Arbitrary** font-size utilities (`text-[26px]`, `text-[13px]`,
  `text-[11.5px]`, …) set _only_ `font-size` — they do **not** emit a paired
  line-height, so the text falls back to the inherited `1.5`. A `text-[26px]`
  value therefore occupies a `26 × 1.5 = 39px` line box, not 24px. (Named
  utilities like `text-sm` _do_ ship a paired line-height; arbitrary ones don't.)

So a KPI value reserved `h-6` (24px) but rendered into a 39px line box — 15px
short on that line alone. Summed across a card (label 18 vs 12, value 39 vs 24,
footnote 17.25 vs 12) each KPI card was **26px shorter** as a skeleton than as
content, and since the KPI row sits at the top of every insights page, the chart
and everything below it shoved down on resolve.

### The fix — reserve one real line box with the CSS `lh` unit

New shared helper `TextLineSkeleton` renders a shimmer bar carrying the **same
font-size class as the real text** and a height of `h-[1lh]` (one line box).
`1lh` resolves to the element's _own_ used line-height, so the placeholder
tracks the real line box for any font-size / inherited line-height with no
pixel arithmetic — the react-loading-skeleton philosophy (size relative to type,
not fixed px) expressed with a modern CSS unit. `lh` is Baseline 2023
(Chrome/Edge 109+, Firefox 120+, Safari 16.4+), well within this dashboard's
target. `KpiCardSkeleton` and the suite-size distribution headers now use it.

**Exception — `leading-none` contexts.** The bottlenecks table cells inherit
`leading-none` (line-height 1) from `TableCell`, so their `text-[13px]` /
`text-[11px]` lines render at the raw font-size, not 1.5×. There the skeleton
reserves `h-[13px]` / `h-[11px]` directly (NOT `1lh`, which would over-reserve).

Charts were already correct: `AnalyticsLineChart` / `BucketBarChart` /
`RunHistoryChart` confine their axis + label rows _inside_ the fixed `height`
box, so `ChartSkeleton height={…}` matched the resolved chart to the pixel.
Left untouched.

## Details — per-region audit (real vs old skeleton) and fix

| Region                             | Old skeleton box                                        | Real box                                                                  | Δ                                | Fix                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KPI card (both insights pages)     | 90px                                                    | 116.25px                                                                  | **+26.25px/card**                | `TextLineSkeleton` bars at the real `text-[12px]`/`text-[26px]`/`text-[11.5px]` line boxes                                                                                                            |
| Bottlenecks table row × up to 20   | 53px/row                                                | 51px/row                                                                  | −2px/row                         | Test cell → `h-[13px]` + `mt-0.5` + `h-[11px]` (leading-none = 26px)                                                                                                                                  |
| Bottlenecks row **count**          | always 20                                               | `bottlenecks.length` (≤20)                                                | huge on partial/last/empty pages | reserve exact count from eager `totals.totalUniqueTests − offset`; `0` → the Empty branch                                                                                                             |
| Bottlenecks **pagination footer**  | _absent_                                                | 57px (multi-page) / 41px (single)                                         | **+41–57px pop-in**              | footer-shaped placeholder (`border-t px-6 py-3`; page-strip only when `totalPages > 1`)                                                                                                               |
| Suite-size distribution header     | `h-4`/`h-3`, wrong `mt-1.5`                             | `text-[13px]`/`text-[11.5px]`, `mt-0.5`                                   | +~5px + wrong gap                | `TextLineSkeleton` + `mt-0.5`                                                                                                                                                                         |
| Suite-size distribution row        | 24px                                                    | 26px                                                                      | +2px/row                         | `text-xs` label line + `mt-1` + `h-1.5` bar (mirrors `DistributionRow`)                                                                                                                               |
| Suite-size tag pill                | `h-[20px]`                                              | 22px                                                                      | +2px/pill                        | `h-[22px]` (18px inline line box + `py-px` + 1px borders)                                                                                                                                             |
| Run-detail history chart title row | separate skeleton markup that drifted from the real row | 21.25px (`text-sm` title baseline-aligned with the branch-filter control) | +4.5px → +1.25px → **0**         | co-locate: a shared `RunHistoryChartFrame` renders the title row (incl. the real, eager branch filter) identically in both states — only the plot body differs, so no measured height to keep in sync |

## Code fixes / migrations

- **`src/components/skeletons.tsx`** — added `TextLineSkeleton` (`1lh` line-box
  helper + a doc block explaining the sizing rule and the `leading-none`
  exception); rewrote `KpiCardSkeleton` to reserve the three real line boxes;
  modernized the (unused) `ListRowsSkeleton` to the same helper; `ChartSkeleton`
  left as-is (already exact).
- **`pages/…/insights/suite-size.tsx`** — imported `TextLineSkeleton`; rewrote
  `DistributionSkeleton` (header line boxes + `mt-0.5`, 26px rows, 22px pills).
  Row/pill counts stay representative, not exact — the real counts are only
  known once the deferred query resolves and this is the **last** card on the
  page, so a differing resolved count resizes this card in place without
  shifting anything else.
- **`pages/…/insights/slowest-tests.server.ts`** — return `offset` + `pageSize`
  (both eager) so the page can compute the exact skeleton row count without
  duplicating `PAGE_SIZE` or importing server-only constants into the client
  bundle.
- **`pages/…/insights/slowest-tests.tsx`** — compute `bottlenecksRowCount` from
  the eager totals; parameterized `BottlenecksSkeleton({ rowCount, totalPages })`
  with an Empty branch, leading-none row heights, and the footer placeholder.
- **`src/components/run-history-chart.tsx`** — extracted `RunHistoryChartFrame`
  (card chrome + title row) now used by the empty branch, the data branch, and a
  new co-located `RunHistoryChartSkeleton` export. `RunHistoryChart`'s public API
  is unchanged, so the two eager test-detail callers are unaffected.
- **`pages/…/runs/[runId]/index.server.ts`** — `branches` moved **eager** (loaded
  in parallel with the tests scan; it's a cheap index-covered `DISTINCT`); the
  `chart` `defer()` now resolves **only** `history`.
- **`pages/…/runs/[runId]/index.tsx`** — the run-detail chart now uses the
  co-located skeleton. The branch filter is hoisted to one `branchFilter` element
  passed to **both** the skeleton fallback and the resolved region, so the title
  row is byte-identical across the Suspense swap and only the plot body changes.
  This **replaced** an earlier stop-gap that pinned the skeleton title row to a
  measured `h-[21.25px]` (a font-metric-derived magic number that would drift if
  the branch-filter control or base font changed) — the shared-frame approach
  computes that height from identical markup instead of hardcoding it. (First
  pass isolated the residual 186px→187.25px shift to the title row by box
  arithmetic, `187.25 − 166` chrome `= 21.25px`, ruling out the SVG/plot, which
  is pinned to `height: 120` in both states.)

## Verification

- `void prepare && tsgo --noEmit` (dashboard `typecheck`) — **0 errors**. The new
  loader props (`offset`, `pageSize`) flow through `InferProps` to the page and
  the parameterized `BottlenecksSkeleton` typechecks.
- `pnpm check` (oxfmt + oxlint + type-aware) — **0 errors**, 120 warnings all
  pre-existing in unrelated files (`error-cause.ts`, e2e helpers); none in the
  five changed files.
- `pnpm --filter @wrightful/dashboard build` — **built cleanly** (the `h-[1lh]`
  arbitrary utility compiles; deferred bundles unaffected; postbuild D1/WS
  patches ran).
- Method: box-exact audit of each deferred region (real content component vs
  skeleton) accounting for Tailwind v4's `line-height: 1.5` + arbitrary-size
  behaviour, cross-checked against a best-practice review (web.dev CLS,
  react-loading-skeleton, the CSS `lh` unit). Runtime confirmation on the dev
  server is the user's next step.

## Residual / notes

- **Variable-length terminal lists** (suite-size distribution) can't be made
  count-exact — their length is what the deferred query computes. They're the
  last element on the page, so their in-place resize contributes ~no CLS; the
  per-row/header/pill boxes are exact.
- **`lh` support** is version-pinned to the Baseline-2023 floor. If a
  pre-2023 engine ever mattered, the `1lh` bars would collapse; the fallback is
  to pin `leading-*` on both the text and the skeleton and reserve a matching
  fixed height.
- The bottlenecks row-height fix depends on `TableCell` keeping `leading-none`;
  a comment in `BottlenecksSkeleton` records the coupling.
- **Preferred pattern for a component with fragile (non-line-box) chrome:
  co-locate the skeleton in the component via a shared frame** (as
  `RunHistoryChartFrame` now does), rather than hand-matching pixels in a
  separate skeleton. The frame's chrome is single-source, so a structural tweak
  updates both states at once and there's no measured height to drift. The
  bottlenecks table + suite-size distribution still hand-match (their real
  markup lives in the page, not a shared component) — candidates for the same
  treatment if they ever grow fragile, but their line-box/derived-count parts
  are already self-correcting.
