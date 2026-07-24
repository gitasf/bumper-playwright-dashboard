import { Link, PREFETCH_STABLE } from "@/components/ui/link";
import {
  SEGMENTED_GROUP_CLASSES,
  segmentedItemClasses,
} from "@/components/segmented-control";
import { cn } from "@/lib/cn";
import { useIsNavigating } from "@/lib/use-is-navigating";

export interface AnalyticsButtonGroupProps<T extends string> {
  options: readonly T[];
  value: T;
  hrefFor: (v: T) => string;
  /** Optional per-option label override (defaults to the value itself). */
  labelFor?: (v: T) => string;
  className?: string;
}

/**
 * Anchor-based segmented button group backing a URL query param. Selection
 * happens by link, not by state, so navigation cost stays cheap and the loader
 * re-runs on navigation to update highlighting via `value`.
 *
 * Goes inert while a page navigation is in flight so switching options quickly
 * can't start an overlapping visit that disposes the pending one and rejects
 * its deferred props (see `useIsNavigating`).
 *
 * Visually identical to `<SegmentedControl>` — both render through the shared
 * class helpers in `segmented-control.tsx`.
 */
export function AnalyticsButtonGroup<T extends string>({
  options,
  value,
  hrefFor,
  labelFor,
  className,
}: AnalyticsButtonGroupProps<T>) {
  const busy = useIsNavigating();
  return (
    <div className={cn(SEGMENTED_GROUP_CLASSES, className)} inert={busy}>
      {options.map((o) => (
        <Link
          key={o}
          cacheFor={PREFETCH_STABLE}
          href={hrefFor(o)}
          className={segmentedItemClasses(value === o)}
        >
          {labelFor ? labelFor(o) : o}
        </Link>
      ))}
    </div>
  );
}
