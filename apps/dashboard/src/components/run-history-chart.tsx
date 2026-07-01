import type React from "react";
import { scaleLinear } from "@visx/scale";
import { Line } from "@visx/shape";
import { Link } from "@void/react";
import { RunHistoryBarHoverCard } from "@/components/run-history-bar-hover";
import { cn } from "@/lib/cn";
import { statusToken } from "@/lib/status";
import { formatDuration } from "@/lib/time-format";

export interface RunHistoryPoint {
  id: string;
  durationMs: number;
  status: string;
  label?: string;
  href?: string;
  current?: boolean;
  /**
   * When present, the bar opens a hovercard with the point's details
   * (fetched lazily on hover). Omit for the current bar or when we don't
   * have the tenant slugs — the bar then renders as a plain link (or
   * non-interactive). `kind` switches between run-level and test-result-
   * level summaries.
   */
  hover?:
    | { kind: "run"; teamSlug: string; projectSlug: string; runId: string }
    | {
        kind: "testResult";
        teamSlug: string;
        projectSlug: string;
        runId: string;
        testResultId: string;
      };
}

/**
 * Default x-axis slot count. The chart right-aligns the most recent
 * `RUN_HISTORY_CHART_MAX_POINTS` points and drops older ones. Callers that
 * derive a summary "over the window the chart plots" should slice their data
 * to this same count so the title/summary can't describe more than is drawn.
 */
export const RUN_HISTORY_CHART_MAX_POINTS = 30;

export interface RunHistoryChartProps {
  points: RunHistoryPoint[];
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  rightSlot?: React.ReactNode;
  /** Height of the plot area (y-axis + bars + x-axis strip). */
  height?: number;
  /**
   * Fixed number of slots reserved along the x-axis. Points are right-aligned
   * into these slots (newest on the right) so bar width stays consistent
   * regardless of how much history we actually have. Default: 30.
   */
  maxPoints?: number;
  emptyState?: React.ReactNode;
  className?: string;
}

/**
 * Tick formatter with sub-second precision so adjacent ticks on a short-
 * duration chart (e.g. 500ms and 1500ms) don't both collapse to "1s" under
 * `formatDuration`'s floor-based rounding.
 */
function formatTick(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) {
    const s = Math.round(seconds * 10) / 10;
    return Number.isInteger(s) ? `${s}s` : `${s.toFixed(1)}s`;
  }
  return formatDuration(Math.round(ms));
}

// Internal SVG coordinate width. The plot <svg> uses viewBox +
// preserveAspectRatio="none" so this is unitless — it scales to fill
// whatever width the container gives it at render time. Bars stretch
// horizontally with the container, which is the natural behaviour for a
// density-based history strip.
const INTERNAL_W = 1000;

// Bottom strip reserved for the x-axis dot row. Pixel-exact (not a
// percentage) because percentage SVG dimensions / CSS paddings resolve in
// ways that don't survive aspect-ratio stretching cleanly.
const X_AXIS_PX = 14;

/**
 * Historical run/test strip — one bar per point, coloured by status, sized by
 * duration. Pure RSC (no client JS): uses visx's
 * SSR-safe primitives (`scaleBand`, `scaleLinear`, `<Bar>`, `<Line>`).
 * Interactive visx helpers (tooltip, brush) would require a client boundary,
 * but we don't need them here.
 *
 * Consumed by both run-detail and test-detail so the two pages share the same
 * visual language for "how has this thing trended lately?".
 *
 * Points should be pre-ordered chronologically (oldest → newest). The bar with
 * `current: true` is highlighted and labelled inline via an HTML overlay
 * (so the text doesn't stretch with the SVG).
 */
export function RunHistoryChart({
  points,
  title,
  subtitle,
  rightSlot,
  height = 120,
  maxPoints = RUN_HISTORY_CHART_MAX_POINTS,
  emptyState,
  className,
}: RunHistoryChartProps) {
  if (points.length === 0) {
    return (
      <div
        className={cn("rounded-lg border border-border bg-card p-4", className)}
      >
        {(title || subtitle) && (
          <div className="mb-3 flex items-baseline gap-2.5">
            {title && <span className="text-sm font-medium">{title}</span>}
            {subtitle && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {subtitle}
              </span>
            )}
          </div>
        )}
        <div className="py-6 text-center text-xs text-muted-foreground">
          {emptyState ?? "No history yet."}
        </div>
      </div>
    );
  }

  // Clamp to the reserved slot count and right-align so the most recent entry
  // always occupies the rightmost slot — matches how readers expect
  // chronological strips to age.
  const effectivePoints =
    points.length > maxPoints ? points.slice(-maxPoints) : points;
  const slotOffset = maxPoints - effectivePoints.length;

  const durations = effectivePoints.map((p) => p.durationMs);
  const rawMax = Math.max(...durations);

  const plotH = height - X_AXIS_PX;

  // Fixed-width domain keyed by slot index. Bars stay a consistent density
  // whether we have 3 points or 30.
  const slotKeys = Array.from({ length: maxPoints }, (_, i) => `s${i}`);
  // `.nice()` rounds the domain up to human-friendly bounds (e.g. 1785 → 2000)
  // so `.ticks()` yields evenly spaced, de-duplicated tick values. Without it
  // the hand-rolled `[max, max*0.66, max*0.33, 0]` schedule produced duplicate
  // labels like "1s / 1s" on short-duration charts.
  const yScale = scaleLinear<number>({
    domain: [0, rawMax > 0 ? rawMax : 1],
    range: [plotH, 0],
    nice: 4,
  });
  const yTicks = yScale.ticks(4);
  // Guarantee the zero baseline is rendered and the top bound is included,
  // even when `.ticks()` omits them (it can return e.g. [500, 1000, 1500]).
  const max = yScale.domain()[1];
  if (yTicks[0] !== 0) yTicks.unshift(0);
  if (yTicks[yTicks.length - 1] !== max) yTicks.push(max);

  return (
    <div
      className={cn("rounded-lg border border-border bg-card p-4", className)}
    >
      {(title || subtitle || rightSlot) && (
        <div className="mb-3 flex items-center gap-3">
          <div className="flex items-baseline gap-2.5 min-w-0">
            {title && (
              <span className="text-sm font-medium truncate">{title}</span>
            )}
            {subtitle && (
              <span className="font-mono text-[11px] text-muted-foreground truncate">
                {subtitle}
              </span>
            )}
          </div>
          {rightSlot && (
            <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-muted-foreground shrink-0">
              {rightSlot}
            </div>
          )}
        </div>
      )}

      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "40px 1fr", height }}
      >
        {/* Y-axis labels — HTML, so text doesn't stretch with the SVG.
         * Positioned absolutely so each label pins to its tick's exact y,
         * matching the dashed gridlines from `yScale.ticks()`. */}
        <div className="relative pr-1 text-right font-mono text-[9.5px] text-muted-foreground">
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

        {/* Plot area */}
        <div className="relative">
          <svg
            width="100%"
            height={height}
            viewBox={`0 0 ${INTERNAL_W} ${height}`}
            preserveAspectRatio="none"
            style={{ display: "block", overflow: "visible" }}
            role="img"
            aria-label={`Duration trend over ${points.length} points`}
          >
            {/* Horizontal gridlines at the scale's nice ticks. vectorEffect
             * keeps strokes crisp under the non-uniform viewBox scaling. */}
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

            {/* x-axis baseline */}
            <Line
              from={{ x: 0, y: plotH }}
              to={{ x: INTERNAL_W, y: plotH }}
              stroke="var(--color-border)"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Bar hit/hover layer — one slot per reserved column. Sits above
           * the SVG and owns click + hover. Lets us attach Popover triggers
           * (HTML-only) without compromising the SVG's `preserveAspectRatio`
           * scaling. Pointer events only apply to the per-point wrappers so
           * the surrounding SVG strokes/labels stay interactive-free. */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 flex"
            style={{ height: plotH }}
          >
            {slotKeys.map((key, i) => {
              const p =
                i >= slotOffset ? effectivePoints[i - slotOffset] : undefined;
              const heightPct = p
                ? Math.max((p.durationMs / (max || 1)) * 100, 1.5)
                : 0;
              return (
                <div
                  key={`hit-${key}`}
                  className="group relative flex-1 px-[1.5px]"
                >
                  {p && (
                    <div
                      className={cn(
                        "absolute inset-x-[1.5px] bottom-0 rounded-sm opacity-70 transition-opacity group-hover:opacity-100",
                        p.current && "opacity-100",
                      )}
                      style={{
                        height: `${heightPct}%`,
                        background: statusToken(p.status),
                      }}
                    />
                  )}
                  {p && <BarHitbox point={p} />}
                </div>
              );
            })}
          </div>

          {/* X-axis dot row — HTML, one slot per reserved position. Dots
           * only render for slots that have a point, so empty leading slots
           * stay blank while still keeping the overall grid alignment. */}
          <div
            className="absolute inset-x-0 bottom-0 flex items-start border-t border-border pt-[3px]"
            style={{ height: X_AXIS_PX }}
          >
            {slotKeys.map((key, i) => {
              const p =
                i >= slotOffset ? effectivePoints[i - slotOffset] : undefined;
              return (
                <div key={`dot-${key}`} className="flex flex-1 justify-center">
                  {p && (
                    <span
                      className="rounded-full"
                      style={{
                        width: p.current ? 5 : 3,
                        height: p.current ? 5 : 3,
                        background: p.current
                          ? "var(--color-info)"
                          : "var(--color-muted-foreground)",
                        opacity: p.current ? 1 : 0.5,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function BarHitbox({ point }: { point: RunHistoryPoint }) {
  const interactive = !!point.href;
  const className =
    "pointer-events-auto absolute inset-0 block cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm";
  const contents = point.label ? (
    <span className="sr-only">{point.label}</span>
  ) : null;

  if (point.hover && interactive) {
    return (
      <RunHistoryBarHoverCard
        {...point.hover}
        href={point.href}
        className={className}
        aria-label={point.label}
      />
    );
  }

  if (point.href) {
    return (
      <Link href={point.href} aria-label={point.label} className={className}>
        {contents}
      </Link>
    );
  }

  // Non-interactive (current bar): render a focusable span only if there's a
  // label, so screen readers can still read "this run · …" — otherwise leave
  // the slot inert so it doesn't steal hover/focus from the neighbouring bars.
  return point.label ? (
    <span className="pointer-events-none absolute inset-0 block" aria-hidden>
      <span className="sr-only">{point.label}</span>
    </span>
  ) : null;
}
