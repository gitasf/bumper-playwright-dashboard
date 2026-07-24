import type React from "react";
import { cn } from "@/lib/cn";

/**
 * Canonical soft-tinted status pill — the one status-label chrome for the app
 * (test/run outcomes via `<StatusBadge>`, monitor states via `<MonBadge>`,
 * API-key state, hover-card run chips). Background is the status token's
 * `-soft` tint, text the full-strength token; pass a leading glyph or dot via
 * `icon`.
 *
 * `cssVar` is the custom-property NAME (e.g. `--fail`); the matching
 * `--<name>-soft` pair must exist in styles.css, which owns the colours.
 */
export function StatusPill({
  cssVar,
  label,
  size = "md",
  icon,
  className,
}: {
  cssVar: `--${string}`;
  label: React.ReactNode;
  size?: "sm" | "md";
  icon?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm font-medium",
        size === "sm"
          ? "px-1.5 py-0.5 text-micro"
          : "px-2 py-[3px] text-caption",
        className,
      )}
      style={{
        background: `var(${cssVar}-soft)`,
        color: `var(${cssVar})`,
      }}
    >
      {icon}
      {label}
    </span>
  );
}
