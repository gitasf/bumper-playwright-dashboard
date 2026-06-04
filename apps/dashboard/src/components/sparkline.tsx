import { statusToken } from "@/lib/status";

export interface SparklinePoint {
  /** Any status string — unknown values render with the fallback colour. */
  status: string;
  /** Optional label shown via the native `<title>` tooltip on hover. */
  label?: string;
}

export interface SparklineProps {
  points: SparklinePoint[];
  /** Oldest on the left, newest on the right. Defaults to true. */
  chronological?: boolean;
  width?: number;
  height?: number;
}

/**
 * Status history bar — one rounded rectangle per historical attempt,
 * vertically centered with padding above/below, separated by a small gap.
 * Pure SVG so it works inside Server Components (no client JS).
 *
 * Visual mirrors the design bundle's `StatusHistoryBar`
 * (`wrightful/project/primitives.jsx:287-300`): `rx="1.5"` rounded corners,
 * 3px top/bottom padding, 2px between bars. The bars read as discrete
 * attempts rather than a continuous edge-to-edge bar.
 *
 * (The component is still named `Sparkline` for historical reasons —
 * callers across the app reference it under that name. Numeric line-chart
 * sparkline work lives in the separate `MetricSparkline`
 * (`analytics/metric-sparkline.tsx`).)
 */
export function Sparkline({
  points,
  chronological = true,
  width = 160,
  height = 22,
}: SparklineProps) {
  if (points.length === 0) {
    return (
      <svg
        aria-label="No runs"
        height={height}
        role="img"
        style={{ display: "block" }}
        width={width}
      />
    );
  }

  const ordered = chronological ? points : [...points].reverse();
  const cellW = width / ordered.length;
  const barH = Math.max(1, height - 6);
  const inset = 1;

  return (
    <svg
      aria-label={`Last ${ordered.length} runs`}
      height={height}
      role="img"
      style={{ display: "block" }}
      width={width}
    >
      {ordered.map((p, i) => (
        <rect
          height={barH}
          key={`${i}-${p.status}`}
          rx="1.5"
          style={{ fill: statusToken(p.status) }}
          width={Math.max(1, cellW - inset * 2)}
          x={i * cellW + inset}
          y={3}
        >
          {p.label ? <title>{p.label}</title> : null}
        </rect>
      ))}
    </svg>
  );
}
