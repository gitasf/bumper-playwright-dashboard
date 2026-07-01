import type React from "react";
import { cn } from "@/lib/cn";

interface PageToolbarProps extends React.ComponentProps<"div"> {
  /**
   * Pin the bar to the top of its scroll container. Used by the tests catalog;
   * a no-op where the page itself doesn't scroll.
   */
  sticky?: boolean;
}

/**
 * Shared controls row that sits directly under the `PageHeader` on list screens
 * (runs / tests catalog / flaky tests / monitors). It owns the chrome — one
 * consistent height (`min-h-13` = 52px), padding, border, and gap — so every
 * page's header region lines up regardless of what's inside.
 *
 * Fill it with the page's filters/search on the left; push view-toggles (range,
 * group, segmented controls) to the right with a `<div className="flex-1" />`
 * spacer. Keep inline content single-line so the bar holds its 52px height.
 */
export function PageToolbar({
  sticky,
  className,
  ...props
}: PageToolbarProps): React.ReactElement {
  return (
    <div
      className={cn(
        "flex min-h-13 shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-2.5",
        sticky && "sticky top-0 z-[4] bg-background",
        className,
      )}
      {...props}
    />
  );
}
