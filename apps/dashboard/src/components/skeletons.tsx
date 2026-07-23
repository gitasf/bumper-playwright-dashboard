import type React from "react";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Reusable Suspense-fallback skeletons for deferred (`defer()`) page regions.
 * Each mirrors the real component's box so streaming in the resolved data
 * causes no layout shift. Page-specific shapes should be built inline from the
 * `Skeleton` primitive; these cover the shapes shared across pages.
 *
 * ## Sizing rule (avoid CLS)
 *
 * A text placeholder must reserve the real text's **line box**, not the glyph
 * height. In this Tailwind v4 app the root line-height is `1.5` and arbitrary
 * font-size utilities (`text-display`, `text-caption`, …) set *only* font-size,
 * so a `text-display` label occupies `26 × 1.5 = 39px` — not 24px. Reserving a
 * fixed `h-6` there leaves the region 15px short and the page jumps when data
 * lands. {@link TextLineSkeleton} sidesteps the arithmetic: it carries the same
 * font-size class as the real text and reserves `h-[1lh]` (one line box), which
 * resolves to whatever line-height is actually in effect. (`lh` is Baseline
 * 2023 — Chrome/Edge 109+, Firefox 120+, Safari 16.4+.)
 */

/**
 * A shimmer bar sized to exactly one line box of the real text it stands in
 * for. Pass the same font-size utility the real text uses (`text-caption`,
 * `text-sm`, …); `h-[1lh]` then resolves to that text's line box, so the
 * placeholder height tracks the real content across font sizes and any
 * inherited line-height with no hardcoded pixels.
 *
 * Do NOT use this for text under an explicit `leading-none` context (e.g.
 * table cells, which set line-height 1) — there the line box equals the raw
 * font-size, so reserve `h-[Npx]` matching that size instead.
 */
export function TextLineSkeleton({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.ReactElement {
  return <Skeleton className={cn(text, "h-[1lh]", className)} />;
}

/**
 * Fallback matching `AnalyticsKpiCard`'s chrome (label / value / footnote).
 * Each bar reserves the real card's line box — label `text-caption` → 18px,
 * value `text-display` → 39px, footnote `text-caption` → 17.25px — so the
 * card is ~116px tall in both states and the KPI row (and everything below it)
 * doesn't shift when the deferred numbers resolve.
 */
export function KpiCardSkeleton(): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-[9px] border border-line-1 bg-bg-1 px-4 py-3.5">
      <TextLineSkeleton className="w-24" text="text-caption" />
      <TextLineSkeleton className="w-16" text="text-display" />
      <TextLineSkeleton className="w-32" text="text-caption" />
    </div>
  );
}

/** Fallback for an analytics chart region. Reserves the chart's exact height.
 *  `AnalyticsLineChart` / `BucketBarChart` confine their axis + label rows
 *  inside the fixed `height` box, so passing the same `height` here matches the
 *  resolved chart to the pixel. Keep this value in lockstep with the chart. */
export function ChartSkeleton({
  height = 320,
}: {
  height?: number;
}): React.ReactElement {
  return <Skeleton className="w-full rounded-md" style={{ height }} />;
}

/**
 * Fallback matching {@link TablePaginationFooter}'s box (border-t, px-6 py-3):
 * a "Showing …" line on the left and, when `showPager`, the previous/next strip
 * on the right — so a paginated table reserves the same footer height in both
 * states and doesn't jump when the deferred rows resolve. Pass `showPager`
 * exactly as the real footer decides it (usually `totalPages > 1`; always for
 * tables that always paginate, never for single-page tables), and pass the real
 * footer's `className` override so the box matches to the pixel.
 */
export function TablePaginationFooterSkeleton({
  showPager = false,
  className,
}: {
  showPager?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "flex min-h-15 items-center justify-between gap-4 border-t border-line-1 px-6 py-3 sm:min-h-14",
        className,
      )}
    >
      <Skeleton className="h-4 w-40" />
      {showPager ? <Skeleton className="h-8 w-64" /> : null}
    </div>
  );
}
