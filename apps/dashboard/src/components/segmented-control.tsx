import type React from "react";
import { cn } from "@/lib/cn";
import { statusToken } from "@/lib/status";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Optional count shown next to the label (e.g. status counts). */
  count?: number;
  /** Optional status-dot color key — renders a small dot before the label. */
  dot?: "passed" | "failed" | "flaky" | "skipped" | "running";
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Tighter padding for compact contexts (sidebars, dense toolbars). */
  compact?: boolean;
}

/**
 * Client-state segmented control. Mirrors the design bundle's
 * `SegmentedControl` (`screen-run-detail.jsx:313-342`): `bg-card border-line-1
 * rounded-md` container with a `bg-bg-3` highlight pill behind the active
 * option, optional status dot + count next to each label.
 *
 * Use this for in-page filter/group-by state. For URL-driven controls (where
 * each click is a navigation), see `<AnalyticsButtonGroup>`.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  compact = false,
}: SegmentedControlProps<T>): React.ReactElement {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-line-1 bg-card p-0.5">
      {options.map((opt) => {
        const active = opt.value === value;
        // `running` is a glyph-only state absent from the status registry, so
        // it keeps its own token; the rest resolve through `statusToken`.
        const dotColor =
          opt.dot == null
            ? null
            : opt.dot === "running"
              ? "var(--running)"
              : statusToken(opt.dot);
        return (
          <button
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[4px] text-[12px] transition-colors",
              compact ? "px-2 py-[3px]" : "px-2.5 py-[3px]",
              active
                ? "bg-bg-3 font-medium text-foreground"
                : "text-fg-2 hover:text-foreground",
            )}
            key={opt.value}
            onClick={() => onChange(opt.value)}
            type="button"
          >
            {dotColor ? (
              <span
                aria-hidden
                className="inline-block size-1.5 rounded-full"
                style={{ background: dotColor }}
              />
            ) : null}
            <span>{opt.label}</span>
            {opt.count != null ? (
              <span
                className={cn(
                  "font-mono text-[11px] tabular-nums",
                  active ? "text-fg-3" : "text-fg-4",
                )}
              >
                {opt.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
