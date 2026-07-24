import type React from "react";
import { cn } from "@/lib/cn";
import { statusToken } from "@/lib/status";

/**
 * Shared chrome for segmented controls, exported so the anchor-based
 * `<AnalyticsButtonGroup>` renders pixel-identically to the client-state
 * `<SegmentedControl>`. `h-8` matches the standard toolbar control height
 * (search inputs, filter triggers) so every control in a `PageToolbar` /
 * `RunsFilterBar` sits on the same line.
 */
export const SEGMENTED_GROUP_CLASSES =
  "inline-flex h-8 items-stretch gap-0.5 rounded-md border border-line-1 bg-bg-1 p-0.5";

export function segmentedItemClasses(active: boolean, compact = false): string {
  return cn(
    // Concentric with the track: rounded-md (4px) − p-0.5 (2px) = 2px inner.
    "inline-flex items-center gap-1.5 rounded-[2px] text-caption transition-colors",
    compact ? "px-2" : "px-2.5",
    active ? "bg-bg-3 font-medium text-fg-1" : "text-fg-2 hover:text-fg-1",
  );
}

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
  /**
   * Hover intent on a single option (fires for the active one too — filter
   * in the caller if it only cares about candidates). Used to prefetch what
   * selecting the option would load (e.g. the replay dialog warming the
   * hovered attempt's trace).
   */
  onOptionHover?: (value: T) => void;
}

/**
 * Client-state segmented control. Mirrors the design bundle's
 * `SegmentedControl` (`screen-run-detail.jsx:313-342`): `bg-bg-1 border-line-1
 * rounded-md` container with a `bg-bg-3` highlight pill behind the active
 * option, optional status dot + count next to each label.
 *
 * Use this for in-page filter/group-by state. For URL-driven controls (where
 * each click is a navigation), see `<AnalyticsButtonGroup>` — same chrome via
 * the shared class helpers above.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  compact = false,
  onOptionHover,
}: SegmentedControlProps<T>): React.ReactElement {
  return (
    <div className={SEGMENTED_GROUP_CLASSES}>
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
            // Selection is otherwise conveyed only by the background pill —
            // expose it to AT as a toggle, matching attempt-tabs.tsx.
            aria-pressed={active}
            className={segmentedItemClasses(active, compact)}
            key={opt.value}
            onClick={() => onChange(opt.value)}
            onPointerEnter={
              onOptionHover ? () => onOptionHover(opt.value) : undefined
            }
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
                  "font-mono text-micro tabular-nums",
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
