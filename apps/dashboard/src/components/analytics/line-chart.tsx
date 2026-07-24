import type React from "react";
import { scaleLinear } from "@visx/scale";
import { Line, LinePath } from "@visx/shape";
import { cn } from "@/lib/cn";
import { ChartColumnTooltip, ChartTooltipProvider } from "./chart-tooltip";

export interface LineChartSeries {
  key: string;
  label: string;
  color: string;
}

export interface LineChartBucket {
  key: string;
  label: string;
  /** Values aligned to the caller-supplied `series` order. `null` = gap. */
  values: (number | null)[];
  /** Tooltip content rendered on hover (portaled Base UI tooltip). */
  tooltip: React.ReactNode;
}

export interface AnalyticsLineChartProps {
  buckets: LineChartBucket[];
  series: LineChartSeries[];
  height?: number;
  emptyState?: React.ReactNode;
  className?: string;
  /** Format a y-axis tick value (e.g. duration in ms → "14m 22s"). */
  formatYTick?: (value: number) => string;
  ariaLabel?: string;
}

const INTERNAL_W = 1000;
const X_AXIS_PX = 22;

function pickLabelIndices(count: number): Set<number> {
  if (count <= 1) return new Set([0]);
  if (count <= 4) return new Set(Array.from({ length: count }, (_, i) => i));
  const last = count - 1;
  return new Set([0, Math.round(last / 3), Math.round((2 * last) / 3), last]);
}

/**
 * Shared line chart. `series` defines the legend order and color;
 * each bucket carries its per-series values aligned by index.
 * Tooltips use the shared `ui/tooltip` (Base UI) — portaled, so the
 * surrounding `overflow-hidden` cards never clip them.
 *
 * SVG rendered with a non-uniform `preserveAspectRatio="none"` viewBox
 * so strokes stretch cleanly to fill the container — same trick used
 * by `BucketBarChart`.
 */
export function AnalyticsLineChart({
  buckets,
  series,
  height = 360,
  emptyState,
  className,
  formatYTick = (v) => String(Math.round(v)),
  ariaLabel = "Line chart",
}: AnalyticsLineChartProps) {
  const hasData = buckets.some((b) => b.values.some((v) => v !== null));
  if (!hasData) {
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

  const allValues: number[] = [];
  for (const b of buckets) {
    for (const v of b.values) {
      if (v !== null) allValues.push(v);
    }
  }
  const rawMax = Math.max(...allValues);
  const plotH = height - X_AXIS_PX;

  const yScale = scaleLinear<number>({
    domain: [0, rawMax > 0 ? rawMax : 1],
    range: [plotH, 0],
    nice: 4,
  });
  const yTicks = yScale.ticks(5);
  const niceMax = yScale.domain()[1];
  if (yTicks[0] !== 0) yTicks.unshift(0);
  if (yTicks[yTicks.length - 1] !== niceMax) yTicks.push(niceMax);

  // X scale — bucket index mapped to SVG width. Points sit at column
  // centres so adjacent lines don't crowd the axis edges.
  const n = buckets.length;
  const xScale = scaleLinear<number>({
    domain: [0, Math.max(1, n - 1)],
    range: [INTERNAL_W / (n * 2), INTERNAL_W - INTERNAL_W / (n * 2)],
  });

  const labelIdx = pickLabelIndices(n);

  return (
    <div className={cn("relative", className)} style={{ height }}>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "56px 1fr", height }}
      >
        <div className="relative pr-1 text-right font-mono text-micro text-fg-3">
          {yTicks.map((t) => (
            <span
              key={t}
              className="absolute right-1 -translate-y-1/2"
              style={{ top: `${(yScale(t) / height) * 100}%` }}
            >
              {formatYTick(t)}
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

            {series.map((s, si) => {
              const points = buckets.map((b, i) => ({
                i,
                v: b.values[si],
              }));
              return (
                <LinePath<{ i: number; v: number | null }>
                  key={s.key}
                  data={points}
                  x={(d) => xScale(d.i)}
                  y={(d) => (d.v === null ? 0 : yScale(d.v))}
                  defined={(d) => d.v !== null}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  fill="none"
                />
              );
            })}
          </svg>

          {/* Column hit-boxes — one per bucket, full height. `group`
           * drives the hover hairline; pointer events stay off the
           * SVG so line strokes don't steal focus from the column. */}
          <ChartTooltipProvider widthClass="w-44">
            <div
              className="pointer-events-none absolute inset-x-0 top-0 flex"
              style={{ height: plotH }}
            >
              {buckets.map((b) => (
                <div key={b.key} className="group relative flex-1 h-full">
                  <ChartColumnTooltip tooltip={b.tooltip} />
                  {/* Vertical hairline shown only on hover. */}
                  <div className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-px -translate-x-1/2 bg-line-1 group-hover:block" />
                </div>
              ))}
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
