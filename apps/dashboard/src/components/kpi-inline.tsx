import type React from "react";
import { cn } from "@/lib/cn";

interface KpiInlineProps {
  label: string;
  value: React.ReactNode;
  /** Tint applied to the value (e.g. var(--flaky) for flake rate). */
  accent?: string;
  className?: string;
}

/**
 * Compact inline KPI cell — used in the flaky-tests `PageToolbar` strip. A
 * small muted label followed inline by a mono tabular-num value, with a
 * vertical divider on the right. Single-line by design so it sits flush in the
 * shared 52px toolbar height alongside filters and view-toggles.
 */
export function KpiInline({ label, value, accent, className }: KpiInlineProps) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-1.5 border-r border-line-1 pr-3 mr-1",
        className,
      )}
    >
      <span className="text-caption font-medium tracking-[0.1px] text-fg-3">
        {label}
      </span>
      <span
        className="font-mono text-body font-semibold tracking-[-0.2px] tabular-nums text-fg-1"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </span>
    </div>
  );
}
