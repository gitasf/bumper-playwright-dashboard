import type React from "react";
import { scaleLinear } from "@visx/scale";
import { Line } from "@visx/shape";
import { cn } from "@/lib/cn";
import { ChartColumnTooltip, ChartTooltipProvider } from "./chart-tooltip";

export interface BucketBarSegment {
  count: number;
  color: string;
}

export interface BucketBarChartBucket {
  key: string;
  label: string;
  /** Bottom-to-top stack order. A single-element array renders a solid bar. */
  segments: BucketBarSegment[];
  /** Sum of segment counts — used to size the bar against the y-axis. */
  total: number;
  /** Tooltip content rendered on hover (portaled Base UI tooltip). */
  tooltip: React.ReactNode;
}

export interface BucketBarChartProps {
  buckets: BucketBarChartBucket[];
  height?: number;
  emptyState?: React.ReactNode;
  className?: string;
  /** Aria-label on the SVG (defaults to "Bucketed bar chart"). */
  ariaLabel?: string;
}

const INTERNAL_W = 1000;
const X_AXIS_PX = 22;

function formatTick(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function pickLabelIndices(count: number): Set<number> {
  if (count <= 1) return new Set([0]);
  if (count <= 4) return new Set(Array.from({ length: count }, (_, i) => i));
  const last = count - 1;
  return new Set([0, Math.round(last / 3), Math.round((2 * last) / 3), last]);
}

/**
 * Shared bar chart. One segment → solid bar, multiple segments →
 * stacked. Y-axis uses `scaleLinear().nice(4)`; x-axis labels are sparse
 * (first / third / two-thirds / last) so 30+ bucket views stay readable.
 * Tooltips use the shared `ui/tooltip` (Base UI) — portaled, so the
 * surrounding `overflow-hidden` cards never clip them.
 */
export function BucketBarChart({
  buckets,
  height = 420,
  emptyState,
  className,
  ariaLabel = "Bucketed bar chart",
}: BucketBarChartProps) {
  if (buckets.length === 0 || buckets.every((b) => b.total === 0)) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-dashed border-line-1 py-16 text-sm text-fg-3",
          className,
        )}
        style={{ minHeight: height }}
      >
        {emptyState ?? "No data in this window."}
      </div>
    );
  }

  const rawMax = Math.max(...buckets.map((b) => b.total));
  const plotH = height - X_AXIS_PX;

  const yScale = scaleLinear<number>({
    domain: [0, rawMax > 0 ? rawMax : 1],
    range: [plotH, 0],
    nice: 4,
  });
  const yTicks = yScale.ticks(4);
  const niceMax = yScale.domain()[1];
  if (yTicks[0] !== 0) yTicks.unshift(0);
  if (yTicks[yTicks.length - 1] !== niceMax) yTicks.push(niceMax);

  const labelIdx = pickLabelIndices(buckets.length);

  return (
    <div className={cn("relative", className)} style={{ height }}>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "48px 1fr", height }}
      >
        <div className="relative pr-1 text-right font-mono text-micro text-fg-3">
          {yTicks.map((t) => (
            <span
              key={t}
              className="absolute right-1 -translate-y-1/2"
              style={{ top: `${(yScale(t) / height) * 100}%` }}
            >
              {formatTick(t)}
            </span>
          ))}
        </div>

        <div className="relative">
          <svg
            width="100%"
            height={height}
            viewBox={`0 0 ${INTERNAL_W} ${height}`}
            preserveAspectRatio="none"
            style={{ display: "block", overflow: "visible" }}
            role="img"
            aria-label={ariaLabel}
          >
            {yTicks.map((t) => (
              <Line
                key={`grid-${t}`}
                from={{ x: 0, y: yScale(t) }}
                to={{ x: INTERNAL_W, y: yScale(t) }}
                stroke="var(--color-border)"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <Line
              from={{ x: 0, y: plotH }}
              to={{ x: INTERNAL_W, y: plotH }}
              stroke="var(--color-border)"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          <ChartTooltipProvider widthClass="w-40">
            <div
              className="pointer-events-none absolute inset-x-0 top-0 flex items-end"
              style={{ height: plotH }}
            >
              {buckets.map((b) => {
                const totalPct =
                  niceMax > 0 ? Math.min((b.total / niceMax) * 100, 100) : 0;
                const denom = b.total || 1;
                return (
                  <div
                    key={b.key}
                    className="group relative flex-1 px-[2px] h-full"
                  >
                    {b.total > 0 && (
                      <div
                        className="absolute inset-x-[2px] bottom-0 flex flex-col-reverse overflow-hidden rounded-t-sm opacity-90 transition-opacity group-hover:opacity-100"
                        style={{ height: `${totalPct}%` }}
                      >
                        {b.segments.map(
                          (seg, i) =>
                            seg.count > 0 && (
                              <div
                                key={i}
                                style={{
                                  height: `${(seg.count / denom) * 100}%`,
                                  background: seg.color,
                                }}
                              />
                            ),
                        )}
                      </div>
                    )}
                    <ChartColumnTooltip tooltip={b.tooltip} />
                  </div>
                );
              })}
            </div>
          </ChartTooltipProvider>

          <div
            className="absolute inset-x-0 bottom-0 flex items-start border-t border-line-1 pt-[4px]"
            style={{ height: X_AXIS_PX }}
          >
            {buckets.map((b, i) => (
              <div
                key={`xl-${b.key}`}
                className="flex flex-1 justify-center font-mono text-micro text-fg-3"
              >
                {labelIdx.has(i) ? b.label : ""}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
