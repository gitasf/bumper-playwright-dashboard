# 2026-07-08 — Run-history chart uses the shared glide tooltip; fix invisible hover skeleton

## What changed

The run-history duration strip (`RunHistoryChart`, shown on the run-detail and
test-detail pages) had its own hover mechanism — a per-bar Base UI **Popover**
(`RunHistoryBarHoverCard`) that opened/closed fresh on each bar. Every other
chart in the app (`BucketBarChart`, `AnalyticsLineChart`) uses the shared,
gliding Base UI **Tooltip** (`ChartTooltipProvider` / `ChartColumnTooltip` in
`analytics/chart-tooltip.tsx`): one popup stays mounted and eases between column
anchors as the pointer sweeps.

Two problems, both now fixed:

1. **Inconsistent tooltip.** The run-history strip is now a set of triggers on
   the same shared glide tooltip as the analytics charts — identical chrome
   (border/radius/shadow), delay, and sweep behaviour. Only the _content_ inside
   differs: the rich, async-fetched run/test summary card. The bar remains a
   navigable `<Link>` (click still opens the run) while also being the tooltip
   trigger.

2. **Invisible loading skeleton.** While the summary fetched, the hover card
   showed a `SummarySkeleton` built with `bg-muted`. In dark mode `--muted`
   resolves to `--bg-2`, which is _also_ the popover/tooltip surface colour, so
   the shimmer bars were the same colour as the background — the popup looked
   empty while loading (reported with a screenshot). The skeleton now uses a
   foreground tint (`bg-fg-4/25` and `bg-fg-4/15`) that contrasts against the
   popup surface in both themes.

## Details

| File                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/components/analytics/chart-tooltip.tsx` | `ChartColumnTooltip` gained an optional `render` prop (typed `TooltipPrimitive.Trigger.Props["render"]`) so a column trigger can be a navigable element (a `<Link>`), not only the default inert `div` hitbox. Default behaviour unchanged for the analytics charts.                                                                                                                                   |
| `src/components/run-history-bar-hover.tsx`   | Rewrote `RunHistoryBarHoverCard` (Popover) → `RunHistoryBarTrigger` (a `ChartColumnTooltip` whose `render` is the bar `<Link>` and whose payload is the new `RunHistoryBarSummary`). Query logic extracted to `summaryQueryKey`; prefetch on `pointerenter`/`focus` retained. `SummarySkeleton` recoloured to `bg-fg-4/*`. Body renderers (`RunSummaryBody`, `TestResultSummaryBody`, etc.) unchanged. |
| `src/components/run-history-chart.tsx`       | Wrapped the bar hit/hover layer in `ChartTooltipProvider widthClass="w-80"` (preserves the previous card width); `BarHitbox` now renders `RunHistoryBarTrigger`.                                                                                                                                                                                                                                       |

### Behavioural note (accepted tradeoff)

With a single shared popup that glides, sweeping onto a bar whose summary isn't
prefetched yet shows the skeleton _mid-glide_ (the popup is already open from the
previous bar), rather than opening fresh with data as the old per-bar Popover
did. This is inherent to the glide model and was explicitly accepted — the
now-visible skeleton makes an in-flight fetch read correctly. Prefetch-on-hover
still covers the common case.

### Why the payload only fetches on hover

`RunHistoryBarSummary` is passed as the `payload` React element for every bar,
but the shared tooltip renders only the _active_ trigger's payload. Creating the
element doesn't run its hooks; only mounting (when its column becomes active)
does — so `useQuery` fires on hover, not once per bar at chart render. TanStack
caches by key, so re-hovering is instant.

### Follow-up: the current bar now hovers too

Previously the currently-viewed run/test bar was fully inert (no `href` _and_ no
`hover`) — you couldn't see its summary, which felt arbitrary. Now every bar
carries a `hover` payload; only the self-navigating `href` is dropped for the
current bar. `RunHistoryBarTrigger` renders a `<Link>` when there's an `href`
and a focusable `<span>` (hover/focus only, `cursor-default`) when there isn't,
so the current bar shows its summary without linking to the page you're already
on. `BarHitbox` now branches on `point.hover` alone rather than
`point.hover && point.href`.

- `runs/[runId]/index.tsx` and `src/lib/test-history-view.ts` (shared by both
  test pages) now always set `hover`, gating only `href` on `isCurrent`.
- Updated the `test-history-view.workers.test.ts` case that asserted the current
  bar had no hovercard.

### Follow-up: stop the tooltip resizing on content swap

The single gliding popup grows/shrinks to fit its content, so two things made it
jump: (1) commit titles wrapped to a second line via `line-clamp-2`, so height
varied bar-to-bar, and (2) the generic 3-line skeleton didn't match the loaded
card's height, so it jumped when data swapped in. Fixes:

- Titles are now single-line (`truncate` instead of `line-clamp-2`) in both
  `RunSummaryBody`/`TitleAndMeta` and `TestResultSummaryBody`. Flex rows (counts,
  meta, commit footer) already don't wrap, so all rows are now fixed-height.
- The shared `SummarySkeleton` was replaced by kind-specific `RunSummarySkeleton`
  / `TestResultSummarySkeleton` that mirror each body's row structure (status
  row, title + meta, commit footer) with bar heights pinned to the text line
  boxes — so the skeleton is dimensionally ~the same as the card it precedes.
  `RunHistoryBarSummary` picks the skeleton by `target.kind` (the chart is
  single-kind). Same house pattern as `RunHistoryChartSkeleton` mirroring
  `RunHistoryChartFrame`.

### Follow-up: pixel-exact skeleton (kill the last few-px shift)

Fixed-px skeleton bars (`h-[18px]`/`h-[13px]`) still drifted a pixel or two,
because the `--text-11`/`--text-12` tokens carry **no paired line-height** — the
`text-*` utility sets only font-size, and the row's real height comes from the
inherited line-height. So a guessed px can't match. Replaced the bars with
`SkelLine`/`SkelPill` primitives that carry the **same** font-size/leading class
as the text they stand in for (`text-sm leading-snug`, `text-11`, and the pill's
`text-11 px-1.5 py-0.5`) plus a zero-width space (`​`) to force a line box —
so the bar height is derived from identical CSS and matches to the pixel. Margins
(`mt-1`) and the footer border/padding are mirrored exactly too.

### Follow-up: don't close chart tooltips on click

Base UI tooltips dismiss on trigger press by default, which is jarring on chart
columns (and on the run-history bars, which navigate on click). `ChartTooltipProvider`'s
`Tooltip` now intercepts `onOpenChange` and calls `details.cancel()` when the
close reason is `"trigger-press"` — so a click keeps the tooltip open. Hover-out,
outside-press, and escape still close normally. Applied once on the shared
provider, so it covers every chart (analytics bucket/line + run-history strip).

### Follow-up: prefetch adjacent bars on hover

Only the run-history strip fetches per bar (analytics charts have static tooltip
payloads — nothing to preload). Sweeping the strip left/right is the dominant
interaction, and with the single gliding popup, landing on an un-prefetched
neighbour shows the skeleton mid-glide. So each bar now warms itself **and its ±1
neighbours** on `pointerenter`/`focus`: the chart passes adjacent points' `hover`
targets into `BarHitbox` → `RunHistoryBarTrigger`, whose `prefetch` loops over
`[self, ...neighbors]` (skipping `undefined` at the strip ends). Cheap — summary
endpoints are small, react-query dedups and caches 60s — and it makes an
adjacent-bar sweep open with data already resolved. `±1` is the balance point;
prefetching the whole window on mount would fire ~5–30 eager requests and defeat
the lazy design.

## Verification

- `pnpm check` (format + lint + type-check) → **exit 0**, 0 errors. (Pre-existing
  unrelated warnings remain in `packages/e2e` and `packages/reporter`.)
- No unit tests reference these components (interaction/visual behaviour).
- Not yet driven live in a browser — recommend a visual pass on a run-detail page
  to confirm the glide sweep and the loading skeleton render as expected.
