import type React from "react";
import { cn } from "@/lib/cn";
import { useIsNavigating } from "@/lib/use-is-navigating";

/**
 * Makes its children inert while a page navigation is in flight, so rapidly
 * clicking navigation-triggering filters can't start an overlapping
 * `router.visit()` (see `useIsNavigating`).
 *
 * Renders with `display: contents` so it adds no box of its own and leaves the
 * surrounding flex layout untouched; `inert` still applies to the whole
 * subtree, disabling every link/input/button inside and dropping them from the
 * tab order. Use it to wrap page-local filter links that don't have a natural
 * container element to mark `inert` themselves (e.g. a row of tag chips).
 */
export function NavBusyGuard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const busy = useIsNavigating();
  return (
    <div className={cn("contents", className)} inert={busy}>
      {children}
    </div>
  );
}
