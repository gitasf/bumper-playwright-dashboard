import { cn } from "@/lib/cn";

/** A point in data space. `x` controls horizontal position. */
export interface NumericSparklinePoint {
  x: number;
  y: number;
}

export interface MetricSparklineProps {
  /**
   * Numeric series, oldest on the left, newest on the right. The fast path:
   * points are evenly index-spaced across the width. Mutually exclusive with
   * `points`.
   */
  values?: number[];
  /**
   * Explicit `{x, y}` points. `x` is normalized into the width by its real
   * value, so sparse/missing x values render as horizontal gaps rather than
   * being silently collapsed to even spacing. Mutually exclusive with
   * `values`.
   */
  points?: NumericSparklinePoint[];
  width?: number;
  height?: number;
  color?: string;
  /** When true (default), draw a filled area under the line. */
  area?: boolean;
  areaOpacity?: number;
  /**
   * Accessible label. Defaults vary by point count; pass an explicit label to
   * describe the series (e.g. "7-day duration trend").
   */
  ariaLabel?: string;
  className?: string;
}

/** What `numericSparkline` resolves a series to, before any SVG is emitted. */
export type NumericSparklineGeometry =
  | { kind: "empty" }
  | { kind: "dot"; cx: number; cy: number }
  | { kind: "line"; line: string; area: string };

/**
 * Pure geometry for a numeric line sparkline. Projects data-space points into
 * the `width`×`height` pixel box (with `pad` inset on every side) and returns
 * the SVG path strings — or a degenerate descriptor for 0/1 points. Extracted
 * so the x/y projection math is unit-testable without rendering.
 *
 * `x` is normalized by its real value across the series' x-range, so callers
 * passing sparse x (e.g. day-of-epoch) get proportional gaps; callers using
 * the index-spaced `values` fast path pass `x = index`, which is uniform.
 */
export function numericSparkline(
  points: readonly NumericSparklinePoint[],
  width: number,
  height: number,
  pad: number,
): NumericSparklineGeometry {
  if (points.length === 0) return { kind: "empty" };
  if (points.length === 1) {
    return { kind: "dot", cx: width / 2, cy: height / 2 };
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = Math.max(1e-9, maxX - minX);
  const rangeY = Math.max(1e-9, maxY - minY);

  const projected = points.map<[number, number]>((p) => [
    pad + ((p.x - minX) / rangeX) * (width - pad * 2),
    height - pad - ((p.y - minY) / rangeY) * (height - pad * 2),
  ]);
  const line = projected
    .map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`))
    .join(" ");
  const firstX = projected[0]?.[0] ?? pad;
  const lastX = projected.at(-1)?.[0] ?? pad;
  const area = `${line} L${lastX},${height} L${firstX},${height} Z`;
  return { kind: "line", line, area };
}

/**
 * Numeric line sparkline (optionally area-filled). Mirrors the design bundle's
 * `Sparkline` from `wrightful/project/primitives.jsx:265-285`. Used inside KPI
 * cards (index-spaced via `values`) and the slowest-tests duration trend
 * (real-x via `points`, where sparse days render as gaps). (The categorical
 * status-bar `Sparkline` in `src/components/sparkline.tsx` is a different
 * visualization despite the shared name.)
 */
export function MetricSparkline({
  values,
  points,
  width = 80,
  height = 22,
  color = "var(--running)",
  area = true,
  areaOpacity = 0.12,
  ariaLabel,
  className,
}: MetricSparklineProps) {
  const pts: NumericSparklinePoint[] =
    points ?? (values ?? []).map((y, x) => ({ x, y }));
  const pad = 1.5;
  const geom = numericSparkline(pts, width, height, pad);

  // `color` may be a CSS `var(...)` reference, which SVG paint attributes
  // can't take directly — apply it as the element's CSS `color` and paint
  // with currentColor so both literal colors and var() references work.
  const baseSvg = {
    className: cn("block", className),
    height,
    style: { color } as const,
    width,
  };

  if (geom.kind === "empty") {
    // Index-spaced KPI usage historically returned null on empty; only the
    // explicit-points (duration-trend) usage rendered a placeholder SVG.
    if (points === undefined) return null;
    return <svg {...baseSvg} aria-label={ariaLabel ?? "No data"} role="img" />;
  }

  if (geom.kind === "dot") {
    return (
      <svg
        {...baseSvg}
        aria-label={ariaLabel ?? "Single data point"}
        role="img"
      >
        <circle cx={geom.cx} cy={geom.cy} r={1.5} fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg
      {...baseSvg}
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
    >
      {area ? (
        <path d={geom.area} fill="currentColor" opacity={areaOpacity} />
      ) : null}
      <path
        d={geom.line}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}
