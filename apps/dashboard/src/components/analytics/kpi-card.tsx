import type { LucideIcon } from "lucide-react";
import { MetricSparkline } from "@/components/analytics/metric-sparkline";

export interface AnalyticsKpiCardProps {
  label: string;
  value: string;
  /** Optional secondary text below the value (e.g. "across 1,234 runs"). */
  footnote?: string;
  /**
   * Optional trend % vs previous window. Renders as a coloured chip in the
   * top-right of the card — green for improvement, red for regression. The
   * direction of "improvement" depends on the metric; callers compute the
   * sign themselves (e.g. higher pass rate is good → positive delta, but
   * higher duration is bad → flip sign before passing).
   */
  delta?: number;
  /**
   * Optional inline numeric sparkline (per-bucket trend over the same
   * window). Renders bottom-right next to the value.
   */
  spark?: number[];
  /**
   * Legacy icon prop — pre-design-port pattern. Renders top-right when no
   * delta is provided; suppressed when delta wins the slot. Most callsites
   * will move to delta + spark; icon remains for callers that have no
   * trend data yet.
   */
  Icon?: LucideIcon;
  iconColor?: string;
}

/**
 * Insights KPI card. Mirrors the design bundle's `KPICard` from
 * `wrightful/project/primitives.jsx:409-431`:
 *
 *   [label                                   delta% or icon]
 *   [value 26px                              optional sparkline]
 *   [optional sub-text 11.5px muted]
 *
 * Card chrome: bg-bg-1, border-line-1, radius 8, padding 14×16.
 */
export function AnalyticsKpiCard({
  label,
  value,
  footnote,
  delta,
  spark,
  Icon,
  iconColor = "var(--color-fg-3)",
}: AnalyticsKpiCardProps) {
  const deltaColor =
    delta == null
      ? undefined
      : delta > 0
        ? "var(--pass)"
        : delta < 0
          ? "var(--fail)"
          : "var(--fg-3)";

  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-[9px] border border-line-1 bg-bg-1 px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-medium tracking-[0.1px] text-fg-3">
          {label}
        </span>
        {delta != null ? (
          <span
            className="font-mono text-micro tabular-nums"
            style={{ color: deltaColor }}
          >
            {delta > 0 ? "+" : ""}
            {delta.toFixed(1)}%
          </span>
        ) : Icon ? (
          <Icon size={16} style={{ color: iconColor }} />
        ) : null}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-display font-semibold tracking-[-0.4px] tabular-nums text-fg-1">
          {value}
        </span>
        {spark && spark.length > 1 ? (
          <MetricSparkline height={22} values={spark} width={80} />
        ) : null}
      </div>
      {footnote ? (
        <span className="text-caption text-fg-3">{footnote}</span>
      ) : null}
    </div>
  );
}
